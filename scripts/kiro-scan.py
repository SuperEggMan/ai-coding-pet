#!/usr/bin/env python3
"""
盘点这台机器上「当前开着的 kiro 窗口 + 每个窗口里有哪些会话面板」,输出 JSON。

桌宠没有 kiro 内核,只能旁路观测。观测分两条道,这个脚本是其中的「盘点」道:

    hook (scripts/kiro-pet-hook.py)  实时,但只有状态,而且是按 cwd 粒度
    本脚本                            分钟级,但能枚举出每个会话面板(id + 标题)

三步链路(都是逆向 kiro 的私有存储,不是公开契约):
  1. 哪些窗口开着 —— `lsof -c Electron` 里被持有的
     `workspaceStorage/<hash>/state.vscdb`(进程名是 Electron,不是 Kiro)
  2. hash → 目录 —— `<hash>/workspace.json` 的 folder / workspace URI
  3. 有哪些会话 —— `state.vscdb`(SQLite)的 `ItemTable['kiro.kiroAgent']`
     里的 `sessionPanels.entries` 与 `sessionPanels.focused`

时效(实测,别再当成"刷盘延迟"):
  用 0.2 秒采样的 watcher 量过 —— 改一次会话标题,**不到 1 秒**就落进
  state.vscdb。kiro 是「有变化就立刻写」,不攒批。
  所以输出里的 `quietSec` 读作「这个窗口多久没发生变化」,**不是**「数据有多旧」:
  某个窗口 quietSec=3700 只说明它一小时没开新会话/没改标题,内容仍然是准的。
  真正的空窗只有"变化发生到写盘"那不到 1 秒。

已知限制,调用方必须按这个预期用:
  * 只有「存在」没有「状态」:看不出在跑、在等授权还是闲着 —— 那是 hook 的活。
  * 依赖 `kiro.kiroAgent` / `sessionPanels.*` 这些私有键,kiro 升级可能改名。
    任何一步失败都降级为"这个窗口没会话",不抛异常。

读库一律先复制到临时文件再查,不碰原库、不吃 WAL 锁。
"""

import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.parse

WS_ROOT = pathlib.Path.home() / "Library/Application Support/Kiro/User/workspaceStorage"
AGENT_KEY = "kiro.kiroAgent"


def open_hashes():
    """当前被 kiro 进程持有的 workspaceStorage hash = 开着的窗口。"""
    try:
        out = subprocess.run(
            ["lsof", "-c", "Electron"], capture_output=True, text=True, timeout=6
        ).stdout
    except Exception:
        return []
    return sorted(set(re.findall(r"workspaceStorage/([^/]+)/state\.vscdb", out)))


def folder_of(d):
    wj = d / "workspace.json"
    try:
        j = json.loads(wj.read_text(encoding="utf-8"))
    except Exception:
        return ""
    uri = j.get("folder") or j.get("workspace") or ""
    if not uri:
        return ""
    p = urllib.parse.unquote(uri.replace("file://", ""))
    # .code-workspace 这类多根工程:取它所在目录,cwd 才落得下去
    return str(pathlib.Path(p).parent) if p.endswith(".code-workspace") else p


def sessions_of(db):
    """从 state.vscdb 里掏出会话面板列表。任何一步失败都返回空。"""
    tmp = None
    try:
        fd, tmp = tempfile.mkstemp(prefix="kiro-scan-", suffix=".db")
        os.close(fd)
        shutil.copy(db, tmp)
        con = sqlite3.connect(tmp)
        try:
            row = con.execute("select value from ItemTable where key=?", (AGENT_KEY,)).fetchone()
        finally:
            con.close()
        if not row:
            return []
        agent = json.loads(row[0])
        entries = agent.get("sessionPanels.entries") or []
        focused = agent.get("sessionPanels.focused")
        out = []
        for e in entries:
            sid = e.get("id")
            if not isinstance(sid, str) or not sid:
                continue
            out.append(
                {
                    "id": sid,
                    "title": (e.get("title") or "").strip(),
                    "focused": sid == focused,
                }
            )
        return out
    except Exception:
        return []
    finally:
        if tmp:
            try:
                os.remove(tmp)
            except Exception:
                pass


def main():
    windows = []
    if WS_ROOT.is_dir():
        for h in open_hashes():
            d = WS_ROOT / h
            db = d / "state.vscdb"
            if not db.exists():
                continue
            folder = folder_of(d)
            if not folder or not os.path.isdir(folder):
                continue  # 取不到落脚目录的窗口(比如临时 workspace)直接跳过
            windows.append(
                {
                    "hash": h,
                    "folder": folder,
                    "quietSec": int(time.time() - db.stat().st_mtime),  # 这个窗口多久没变化(不是数据有多旧)
                    "sessions": sessions_of(db),
                }
            )
    # sys.stdout 同样依赖进程 locale——直接写 buffer + 显式 utf-8,不给
    # execFile 的子进程环境留"这台机器 locale 不是 utf-8"的空子。
    sys.stdout.buffer.write(json.dumps({"windows": windows}, ensure_ascii=False).encode("utf-8"))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stdout.buffer.write(json.dumps({"windows": [], "error": "scan-failed"}).encode("utf-8"))
    sys.exit(0)
