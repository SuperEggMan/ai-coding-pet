# 安装 · 打包 · 支持矩阵

## 一、支持的 AI Coding 软件

| 软件 | 支持度 | 接入方式 |
|---|---|---|
| Claude Code | ✅ 原生内置 | 桌宠自己持有一个 Claude Agent SDK 会话：消息流阅读、发指令、canUseTool 权限拦截（请奏/请择）全在桌宠内完成。需要本机已登录 Claude Code（或设置 `ANTHROPIC_API_KEY`） |
| Kiro | 🟢 已做旁路适配（观测） | 两条道并用：①`scripts/kiro-pet-hook.py` + `.kiro/hooks/pet-*.json`（SessionStart / UserPromptSubmit / PreToolUse / Stop）上报**状态**；②`scripts/kiro-scan.py` 逆向读 `workspaceStorage` 盘点**当前开着哪些窗口、每个窗口有哪些会话面板**，主进程每 30 秒同步成宠物（kiro 写库是即时的，30 秒一轮够跟手）。**只能看，不能指挥**：阅读流拿不到（hook 没有正文触发点），输入框对它无效 |
| Codex / Cursor 等 | ⚠️ 未内置适配 | 没有现成适配器。可以走「旁路上报协议」接入：把事件/权限请求 POST 到本机 `127.0.0.1:47800` 的 `/permission`、`/event`、`/transcript`，宠物即认；需要为每个工具写一个小适配器做协议翻译，参考 `scripts/kiro-pet-hook.py` |
| 任意能调本地 HTTP 的工具 | 🟡 协议开放 | 同一旁路通道 |

> demo 剧本里出现的 `codex` 是虚构会话标签，只用于演示旁路能力，不代表已适配对应产品。

### Kiro 旁路适配的已知边界

- **扫描不负责状态，只负责名单。** 时效不是问题：用 0.2 秒采样量过，kiro 是「有变化就立刻写」，改一次会话标题不到 1 秒就落进 `state.vscdb`，不攒批。扫描输出里的 `quietSec` 读作「这个窗口多久没发生变化」，**不是**「数据有多旧」——某个窗口 `quietSec=3700` 只说明它一小时没开新会话/没改标题，内容仍然是准的。
- **hook 路由是精确的**（一度以为不是，实测推翻）。kiro 的 hook payload 本身就带 `session_id: "sess_..."`，而且跟 `kiro-scan.py` 从 `state.vscdb` 读到的 `sessionPanels.entries[].id` 是同一个 id，所以一个窗口开多个会话面板也不会打错。`store._resolveId()` 里按 cwd + 聚焦去猜的那条是**退化路径**，留给不给会话标识的其它旁路客户端。
- 「去 Kiro」按钮走的是客户端自带 CLI（`<App>.app/Contents/Resources/app/bin/<name>`，Kiro 里那个叫 `code`），**不是 `open -a`**——后者会再开一个窗口，哪怕目录已经开着（踩过）。也别加 `-r/--reuse-window`，那是"拿最后活跃的窗口装这个目录"，会把人家正开着的工程顶掉。
- payload 里还有 `tool_name` / `tool_input`，所以「正在干什么」能说到具体命令/文件，不只是工具名。抓原始 payload 的办法：在 `kiro-pet-hook.py` 的 `read_ctx()` 里临时把 stdin 写进一个文件，随便跑个工具就有了。
- **hook 要装在 `~/.kiro/hooks/`（用户级）**，不是某个工程的 `.kiro/hooks/`。装成 workspace 级只有那一个工程会上报，别的工程的宠物永远停在「待命」（踩过）。用户级是被支持的——git-ai 就装在那儿。两处都放会重复触发。
- 依赖 `kiro.kiroAgent` / `sessionPanels.*` 这些私有存储键，以及 `lsof -c Electron` 这个进程名。**这是逆向，不是契约**，kiro 升级可能失效；失效时降级成"扫不到窗口"，不会报错也不会误删宠物。
- 扫描**只做加法不主动删**：扫不到很可能只是还没刷盘。只有从没收到过 hook 事件、还停在待命的空壳宠物，才会在窗口关闭后被收掉。

## 二、开发运行

```bash
npm install
AICP_SKIN=yunnuo npm start      # 真实模式：托盘 + 左下角开张宝盒
AICP_SKIN=yunnuo npm run demo   # 演示剧本（真实 HTTP 通道全链路）
AICP_SKIN=yunnuo npm run poses  # 八态位姿检查台
```

皮肤目录：`src/skins/<皮肤名>/`，`AICP_SKIN=<皮肤名>` 一行切换（zhunzou / yunnuo）。

## 三、打包安装包

打包工具：electron-builder（已写入 package.json 的 `build` 配置与脚本）。

```bash
# 首次先安装打包器
npm install -D electron-builder

# macOS 安装包（.dmg + .zip）
npm run dist:mac

# Windows 安装包（NSIS .exe）
npm run dist:win
```

产物输出到 `release/`。

注意：
- **建议在目标系统上各自打包**：mac 上打 mac 包、Windows 上打 win 包，最稳。
- mac 上交叉打 Windows 包需要额外工具链（wine 等），不一定开箱即用。
- 未配置代码签名时，安装包会有「未验证开发者」提示：mac 首次打开需右键→打开，或 `xattr -cr`；正式分发请配置 Apple Developer 签名 / Windows 代码签名证书。
- 打包会自动携带 `node_modules` 里的运行时依赖（Claude Agent SDK、ws）；Electron 本体由 devDependencies 决定版本。
- 安装包图标取自 `build/icon.png`（可用 `src/skins/*/frames/idle.png` 替换重生成）。

## 四、真机运行前提（真实 coding 会话）

- 本机需 Claude Code 登录：`claude` 命令可用，或设置 `ANTHROPIC_API_KEY`。
- 权限模式默认「逐事请奏」；改文件免奏 / 先议后行 / 一概免奏在会话面板右上角切换。
