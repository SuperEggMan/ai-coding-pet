#!/usr/bin/env python3
"""
Kiro → AI Coding Pet 的旁路适配器。

Kiro 没有内置适配(桌宠只原生驱动 Claude Code),只能靠 hook 在几个预设触发点
把事件 POST 到本机桌宠的 127.0.0.1:47800/event。这个脚本就是那层协议翻译。

用法(由 .kiro/hooks/*.json 调用):
    kiro-pet-hook.py <kind>          stdin = Kiro hook 给的 JSON 上下文

    kind 取值与挂载点:
      session_start  SessionStart      登记一只宠物
      prompt         UserPromptSubmit  切「运行中」并取标题
      tool_pre       PreToolUse        动作计数 + 「正在干什么」+ 危险度三色的入参
      tool_post      PostToolUse       阅读流主体(tool_response 是工具真实输出)
      grant          PreToolUse        请奏:**阻塞**等人批,驳回时 exit 2 拦住工具

路由(实测 kiro 的 payload 长这样):
    {"session_id":"sess_b6c5be2a-...","hook_event_name":"PreToolUse",
     "cwd":"/path","tool_name":"execute_bash","tool_input":{...}}
  那个 `sess_...` 跟 scripts/kiro-scan.py 从 state.vscdb 读到的
  `sessionPanels.entries[].id` **是同一个 id**,所以能精确落到某个会话面板上
  —— 一个 kiro 窗口开多个面板时,状态不会打错在隔壁那只身上。
  拿不到时才退回 `kiro-<md5(cwd)>`(只有工程粒度),桌宠侧会按 cwd + 聚焦去猜。
  * **绝不能影响 kiro 自己的会话**:任何异常都吞掉、超时就放过。
    退出码只有 `grant` 分支可能是 2(且仅在人明确驳回时),其余一律 0。
  * **绝不能往 stdout 写东西**:SessionStart / UserPromptSubmit 这类 hook 的
    stdout 会被塞进模型上下文,打印任何内容都是在污染对话。
    驳回理由写 stderr —— 那条会被送到 agent 眼前,正是我们想要的。
"""

import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:47800"
ENDPOINT = BASE + "/event"
PERMISSION_ENDPOINT = BASE + "/permission"
TIMEOUT = 1.5

# 「请奏」是同步阻塞的:hook 挂在这儿等人在宠物身上按准奏/驳回。
# 必须略小于 .kiro/hooks/pet-grant.json 里的 action.timeout,
# 让脚本自己超时返回(=放行)而不是被 kiro 杀掉。
GRANT_TIMEOUT = 290

# 一键停用请奏:这个文件存在就直接放行,连桌宠都不问。
# 留它是因为请奏挂在 PreToolUse 上、是同步阻塞的 —— 万一桌宠出问题把 kiro
# 拖住,得有个不依赖桌宠、不依赖改 hook 配置就能立刻止血的开关。
GRANT_OFF = os.path.join(os.path.expanduser("~"), ".ai-coding-pet", "grant.off")

# 单个入参字段留多长。fs_write 的 text 可能是整个文件,原样发过去既浪费带宽
# 又会把阅读流糊成一片,所以在**发出前**就截断。
FIELD_MAX = 400
RESULT_MAX = 1200


def read_ctx():
    """Kiro 传进来的 JSON 上下文。字段名各版本可能不同,所以取值一律走多候选。"""
    try:
        # sys.stdin 默认按进程 locale 解码,不是强制 utf-8——GUI 应用拉起的
        # hook 子进程环境经常没有 LANG/LC_ALL,读到的中文标题/命令会先在这里
        # 就错码。改走 buffer 按 utf-8 硬解,不依赖外部环境变量。
        raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    except Exception:
        return {}
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def pick(ctx, *names):
    for n in names:
        v = ctx.get(n)
        if isinstance(v, str) and v.strip():
            return v.strip()
        if isinstance(v, dict):
            inner = v.get("name") or v.get("path")
            if isinstance(inner, str) and inner.strip():
                return inner.strip()
    return ""


def tool_detail(ctx):
    """从 tool_input 里挑一个能一眼看懂的细节,截短。挑不到就返回空串。"""
    ti = ctx.get("tool_input")
    if not isinstance(ti, dict):
        return ""
    for k in ("command", "path", "query", "targetFile", "url"):
        v = ti.get(k)
        if isinstance(v, str) and v.strip():
            one = " ".join(v.split())
            return " · " + (one[:44] + "…" if len(one) > 45 else one)
    return ""


def clip_input(ctx):
    """
    把 tool_input 缩成能安全传输的样子。

    两个理由:
    ① 体积。`fs_write` 的 `text` 是整个文件正文,几十 KB 打过去毫无意义。
    ② 判据够用就行。桌宠侧的危险度判定(states.js 的 classifyGrant)只需要
       命令行、路径这些特征字符串,不需要文件全文。
    """
    ti = ctx.get("tool_input")
    if not isinstance(ti, dict):
        return {} if ti is None else {"_": str(ti)[:FIELD_MAX]}
    out = {}
    for k, v in ti.items():
        if isinstance(v, str):
            out[k] = v[:FIELD_MAX]
        elif isinstance(v, (int, float, bool)) or v is None:
            out[k] = v
        else:
            # 数组/嵌套对象:序列化后截断,保留特征字符串给正则匹配
            try:
                out[k] = json.dumps(v, ensure_ascii=False)[:FIELD_MAX]
            except Exception:
                out[k] = str(v)[:FIELD_MAX]
    return out


def tool_output(ctx):
    """PostToolUse 的 `tool_response` —— 工具的真实输出,阅读流的主体内容。"""
    for key in ("tool_response", "toolResponse", "tool_result", "output", "result"):
        v = ctx.get(key)
        if isinstance(v, str) and v.strip():
            return v[:RESULT_MAX]
        if isinstance(v, (dict, list)) and v:
            try:
                return json.dumps(v, ensure_ascii=False)[:RESULT_MAX]
            except Exception:
                return str(v)[:RESULT_MAX]
    return ""


def post(url, payload, timeout):
    """POST 一段 JSON,返回解析后的响应；任何问题都返回 None（调用方按放行处理）。"""
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    try:
        raw = urllib.request.urlopen(req, timeout=timeout).read()
    except Exception:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return {}


def do_grant(ev, ctx):
    """
    请奏:把这次工具调用拦在桌宠上等人批。

    **fail-open 是铁律**,任何一条不确定都放行:
      - 停用开关文件存在        → 放行
      - 桌宠没起 / 端口没人听   → 放行
      - 超时(人没管)           → 放行
      - 响应看不懂             → 放行
    只有明确收到 `deny` 才 exit 2 拦住。

    注意这跟 claude 内核那边的语义**相反**(那边超时=驳回)。原因是 kiro 的
    hook 超时行为是放行,我们没法改;硬做成 fail-closed 只会得到"桌宠一崩,
    kiro 就干不了活"。所以这里明确选择:宁可漏拦,不可把人锁在门外。
    """
    if os.path.exists(GRANT_OFF):
        return 0

    ev = dict(ev)
    ev["tool"] = pick(ctx, "tool_name", "toolName", "tool")
    ev["input"] = clip_input(ctx)
    ev["summary"] = f"{ev['tool']}{tool_detail(ctx)}".strip() or "一次工具调用"
    ev.pop("kind", None)  # /permission 自己盖 kind=permission_request

    resp = post(PERMISSION_ENDPOINT, ev, GRANT_TIMEOUT)
    if not isinstance(resp, dict):
        return 0
    if resp.get("decision") == "deny":
        # stderr 会原样送到 agent 眼前,让它知道是被人驳回的、不是工具坏了
        note = resp.get("note") or ""
        sys.stderr.write(f"桌宠驳回:{ev['summary']}" + (f"（{note}）" if note else "") + "\n")
        return 2
    return 0


def main():
    kind = sys.argv[1] if len(sys.argv) > 1 else ""
    if not kind:
        return

    ctx = read_ctx()
    cwd = pick(ctx, "cwd", "workspacePath", "workspace_root", "workspaceRoot", "projectPath") or os.getcwd()
    kiro_sid = pick(ctx, "session_id", "sessionId", "conversationId")

    ev = {
        # 有真 id 就用它,桌宠按 kiro_session_id 精确匹配;没有才退回 md5(cwd)
        "session_id": kiro_sid or ("kiro-" + hashlib.md5(cwd.encode("utf-8")).hexdigest()[:10]),
        "kiro_session_id": kiro_sid,
        "kind": kind,
        "agent": "kiro",
        "cwd": cwd,
        "project": os.path.basename(cwd.rstrip("/")) or cwd,
    }

    # 请奏是唯一会阻塞、也是唯一可能返回非 0 的分支,单独走一条路
    if kind == "grant":
        return do_grant(ev, ctx)

    if kind == "session_start":
        ev["title"] = ""
    elif kind == "prompt":
        # title = 「你要它干什么」,取用户这句话的首行
        ev["text"] = pick(ctx, "prompt", "userPrompt", "user_prompt", "message", "text")
    elif kind == "tool_pre":
        # 动作计数与「正在干什么」都挂在 PreToolUse:store 的计数只在 tool_pre 上 +1。
        tool = pick(ctx, "tool_name", "toolName", "tool")
        ev["tool"] = tool
        # payload 带 tool_input,能把"在干什么"说具体一点,而不是只报个工具名;
        # 同时把(截断后的)入参一起送上去 —— 桌宠侧据此判危险度三色。
        ev["input"] = clip_input(ctx)
        ev["text"] = f"正在 {tool}{tool_detail(ctx)}" if tool else "正在干活"
    elif kind == "tool_post":
        # 阅读流的主体:PostToolUse 的 payload 里有 `tool_response`,
        # 就是工具的真实输出。早先"hook 拿不到正文所以读不了"的结论是错的。
        tool = pick(ctx, "tool_name", "toolName", "tool")
        ev["tool"] = tool
        ev["result"] = tool_output(ctx)
        # kiro 没有显式的成功/失败标志,只能从输出里认特征。宁可报成功也别乱标红。
        low = ev["result"][:200].lower()
        ev["ok"] = not any(w in low for w in ("error:", "failed", "exception", "traceback"))
        ev["text"] = f"{tool} 完成" if tool else "一个动作完成"
    elif kind == "stop":
        ev["text"] = "kiro 这一轮跑完了"

    # 桌宠没开、端口没人听、超时……都不是 kiro 会话该关心的事,静默放过
    post(ENDPOINT, ev, TIMEOUT)
    return 0


if __name__ == "__main__":
    code = 0
    try:
        code = main() or 0
    except Exception:
        # 任何意外都不许影响 kiro 自己的会话
        code = 0
    sys.exit(code)
