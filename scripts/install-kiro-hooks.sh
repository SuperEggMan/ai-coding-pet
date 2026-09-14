#!/usr/bin/env bash
# 把桌宠的 Kiro hooks 安装到用户级 ~/.kiro/hooks/。
# 自动填入本仓库 kiro-pet-hook.py 的绝对路径，无需手改。
#
# 用法:
#   bash scripts/install-kiro-hooks.sh            # 安装（请奏默认关闭）
#   bash scripts/install-kiro-hooks.sh --uninstall # 卸载全部 pet-* hook
#
# 说明:
# - hook 必须装在「用户级」~/.kiro/hooks/，不是某个工程的 .kiro/hooks/，
#   否则只有那一个工程的会话会上报。
# - 请奏(pet-grant，PreToolUse 阻塞审批)默认 enabled:false —— 它会挂在
#   Kiro 的执行路径上，必须你明确打开(改 enabled 或用托盘开关)。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK_PY="$SCRIPT_DIR/kiro-pet-hook.py"
HOOKS_DIR="$HOME/.kiro/hooks"

if [[ "${1:-}" == "--uninstall" ]]; then
  rm -f "$HOOKS_DIR"/pet-session-start.json "$HOOKS_DIR"/pet-prompt.json \
        "$HOOKS_DIR"/pet-tool.json "$HOOKS_DIR"/pet-tool-post.json \
        "$HOOKS_DIR"/pet-stop.json "$HOOKS_DIR"/pet-grant.json
  echo "已卸载全部 pet-* hook。"
  exit 0
fi

mkdir -p "$HOOKS_DIR"

# 生成一个 hook 文件: 名称 触发点 kind 超时 是否启用 描述
gen() {
  local file="$1" name="$2" trigger="$3" kind="$4" timeout="$5" enabled="$6" desc="$7" matcher="${8:-}"
  local matcher_line=""
  if [[ -n "$matcher" ]]; then
    matcher_line="\"matcher\": \"$matcher\","
  fi
  cat > "$HOOKS_DIR/$file" <<JSON
{
  "version": "v1",
  "hooks": [
    {
      "name": "$name",
      "trigger": "$trigger",
      $matcher_line
      "description": "$desc",
      "action": {
        "type": "command",
        "command": "/usr/bin/env python3 \"$HOOK_PY\" $kind",
        "timeout": $timeout
      },
      "timeout": $timeout,
      "enabled": $enabled
    }
  ]
}
JSON
  echo "  写入 $HOOKS_DIR/$file (enabled=$enabled)"
}

echo "安装桌宠 Kiro hooks 到 $HOOKS_DIR"
echo "  hook 脚本: $HOOK_PY"

gen pet-session-start.json "桌宠 · 会话开始" SessionStart session_start 5 true \
  "Kiro 会话开始时在桌宠登记一只宠物。桌宠没开时静默跳过。"
gen pet-prompt.json "桌宠 · 收到指令" UserPromptSubmit prompt 5 true \
  "你发出指令时把桌宠切成「运行中」，并把首行作为标题显示。"
gen pet-tool.json "桌宠 · 动作计数" PreToolUse tool_pre 5 true \
  "每次工具调用前报一声：动作数 +1，显示正在做什么、危险度入参。"
gen pet-tool-post.json "桌宠 · 阅读流" PostToolUse tool_post 5 true \
  "工具调用后把真实输出上报为阅读流(会话面板能读)。"
gen pet-stop.json "桌宠 · 一轮结束" Stop stop 5 true \
  "一轮跑完切「复奏」，提醒你去看结果。"
# 请奏默认关闭：会阻塞 Kiro 执行路径，必须显式打开
gen pet-grant.json "桌宠 · 请奏（拦下危险操作等我批）" PreToolUse grant 300 false \
  "危险操作执行前拦住，弹到桌宠等你准奏/驳回；驳回则 hook exit 2 不执行。默认关闭。铁律 fail-open：桌宠没开/超时/异常一律放行。止血: touch ~/.ai-coding-pet/grant.off" \
  "^(fs_write|fs_append|str_replace|delete_file|smart_relocate|execute_bash|execute_pwsh|control_bash_process|control_pwsh_process)\$"

echo "完成。请奏(pet-grant)默认关闭；要启用见 README「请奏」一节。"
