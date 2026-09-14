# 桌宠对 kiro 的深度支持

2026-09-09 落地。四件事：**会话身份名牌**、**真阅读流**、**危险度三色**、**请奏（阻塞审批）**。

先纠正两个早先写进代码注释、也说给用户听过的错误结论：

| 早先的说法 | 实际 |
|---|---|
| 「hook 拿不到正文，阅读流永远是空的」 | **错**。`PostToolUse` 的 payload 带 `tool_response`（工具真实输出），`PreToolUse` 带 `tool_input`。agent 干活的主体就是工具调用和它们的输出，缺的只有 assistant 的自然语言旁白。 |
| 「桌宠只能看，不能指挥 kiro」 | **一半是错的**。`PreToolUse` 用 `exit 2` **真的能拦住工具执行**，stderr 会原样送到 agent 眼前。发起对话确实做不到（hook 只能被动响应），但**拦截和放行做得到**。 |

---

## 一、会话身份名牌

### 要解决什么

多只宠物折叠站成一排时，右上的状态点告诉你「要不要管它」，但压根看不出「**这只是哪个会话**」。

### 为什么是脚下名牌

在 84px 舞台上把六种方案渲染出来逐个看过（1x 真实观感，不是放大图）：

| 方案 | 1x 可读性 | 结论 |
|---|---|---|
| 脚下名牌 11px / 2~4 字 | 认得出，4 字（53px）是极限 | ✅ **采用** |
| 脚下名牌 10px / 5 字 | 开始糊，靠猜 | ⚠️ |
| 脚下名牌 9px / 6 字 | 一条糊带，完全认不出 | ❌ |
| 左上单字徽标 | 字勉强可辨，但压在耳朵上；单字不区分同项目 | ❌ |
| 脚下色环 + 单字 | 环里的字彻底看不见，像装饰阴影；还撞 stale/请择的橙 | ❌ |
| 头顶名牌 | 最清楚（不压身体） | ⚠️ 要把窗口加高到 118，且跟气泡抢同一块地方 |

**11px 最多 4 个汉字**，这是 84px 舞台的硬上限。

### 两条必须记住的判据

**① 内容用会话标题，不是目录名。** 把「同一个项目开 3 个会话」摆出来一比就清楚：用 `project`（目录名）三只长得一模一样，等于没做这个功能；用 `title` 前 4 字立刻分开。真机验证时正好扫到两个都属于 `CenterSite` 的会话，名牌显示 `New Sess` / `AI总结+`，分得开。

降级链：`title` → `project` → `agent`。`title` 是「等待 kiro 接入 · xxx」这种占位文案时要过滤掉，那不是身份。

**② 底色用中性墨色，绝不用 `var(--accent)`。** 状态色已经吃掉灰蓝/蓝/红/橙/绿/褐六个色区（见 `skins/*/skin.json`），身份再用彩色，用户分不清哪个色说状态、哪个色说身份 —— 实测绿名牌配 `done` 的绿状态点，两个绿挨着就糊了。**颜色语义整块留给状态点，身份只用文字。**

### 实现落点

| 文件 | 改了什么 |
|---|---|
| `src/renderer/ident.mjs` | 新增。`identLabel()` / `identSource()` / `truncVisual()` |
| `src/renderer/pet.html` | `#stage` 内加 `<span id="identTag">` |
| `src/renderer/pet.css` | `.ident-tag` |
| `src/renderer/pet.js` | `renderIdentTag()`，在 `render()` 里调 |
| `src/main/store.js` | `snapshot()` 加 `petCount` |

三个容易踩的点：

- **按视觉宽度截断，不是 `slice(0, 4)`**（全角 2 单位、半角 1、上限 8）。标题是 `fix login bug` 这种纯英文时，4 个字符只剩 `fix `，没有任何信息量。
- **`pointer-events: none` 是必需的**。名牌比宠物本体宽，吃了鼠标就等于把热区撑成矩形；而 `isOverSolid()` 靠 `elementFromPoint` 判实体像素，加了这行它会自动跳过名牌，**不用去改命中测试白名单**。已验证：点在名牌位置上，点击穿过去命中宠物本体、档位正常轮转，没制造死区。
- **只在 `petCount > 1` 时显示**。独苗压根不存在「分不清哪只是哪只」的问题，挂了只是白遮住脚。
- 名牌宽度控在 84px 内是刻意的：折叠窗口就是 `100×100`（`--stage: 84px` + `.root.collapsed .stage` 那圈 ±8 负边距刚好铺满）且 `overflow: hidden`，超出会被硬裁；相邻宠物之间只有 `PET_GAP = 14px`，靠加宽窗口那条路走不通（要同步改 `COLLAPSED.width` + `ROW_FOOTPRINT.collapsed` + `--stage` 三处）。

`ident.mjs` 用 `.mjs` 扩展名不是随手起的：包目录是 CJS（`package.json` 没有 `type: module`），`.js` 会被 node 当 CJS 解析。用 `.mjs` 才能被 node 直接 `import` 做单测，而浏览器侧照常按 ESM 加载。这两条规则是量出来的、最怕被人随手改坏，所以要能测。

---

## 二、真阅读流

`PostToolUse` → 桌宠 `/event` → `PassiveStream` → 会话面板。

会话面板从空壳变成「能看见它在干什么、结果是什么」。缺的只有 assistant 的自然语言旁白 —— 那个 hook 确实没有触发点，界面上如实说明，不写成「正在加载」让人等一个不会到的东西。

### 为什么要单独一个 `PassiveStream`

桌宠原生驱动的 Claude 会话有 `AgentSession`，阅读流由它的 `tail` 累积。旁路会话（`ext-` 开头）没有内核实例，`agents.get(id)` 取不到东西 —— 结果就是面板一片空白。`src/main/passive-stream.js` 就是给旁路会话补上那份 `tail`。

事件映射：

```
prompt              → user 气泡
tool_pre            → tool 行（带危险度 tier）
tool_post           → tool_result 行（带 ok）
permission_request  → notice「请奏：…」
resolved            → notice「准奏 / 永准 / 驳回」
stop                → notice「这一轮跑完了」
session_start       → 不进流（噪音）
```

三个细节：

- **必须用 `store.apply()` 归一后的 `s.id`**，不能直接拿 `raw.session_id`。旁路上报的 id 会被 `_resolveId` 认领到别只宠物身上，用错了会把内容写进隔壁那只的流里。
- **两级截断**。`fs_write` 的 `text` 可能是整个文件：hook 侧每个字段截到 400（`FIELD_MAX`），工具输出截到 1200（`RESULT_MAX`），主进程侧再兜底一次。判危险度只需要命令行、路径这些特征字符串，不需要文件全文。
- **空输出不塞空气泡**。纯副作用的写文件常常没有返回内容；但如果 `ok === false`，即使没输出也要报一条失败，否则「失败了却什么都没显示」。

窗口是后建的、或者被回收又叫回来时，`pet:ready` 和 `ensurePetWindow()` 都会把已攒下的 `tail` 补发过去，不然面板会莫名空白。

---

## 三、危险度三色

判据**直接复用 `states.js` 的 `classifyGrant`** —— 跟「请奏」用的是同一份规则，不另写一套，否则两边会漂。红=命中破坏性特征（`rm -rf` / `git push --force` / `drop table` / `sudo` / 管道进 shell …），黄=写入或执行，蓝=只读，认不出的一律算黄（低估风险的代价比多问一句大）。

渲染上只是 `.msg-tool` 的左边框着色 + 红档加粗，`title` 属性挂命中理由。**这一步只着色，不拦任何东西**；拦是下面「请奏」那条路。

---

## 四、请奏（阻塞审批）

`PreToolUse` 用 `exit 2` 真能拦住工具执行，而桌宠侧的阻塞审批通道（`/permission` + `/decision` + `resolvePermission` + 准奏/永准/驳回 UI）**早就为旁路协议建好了，一直空着没接**。这次只是把 hook 那一头补上，再加一道闸门。

### ⚠️ 默认关闭，两把锁

请奏会挂在 kiro 的执行路径上，不该由我们替用户默默打开。两处都要动才生效：

1. `~/.kiro/hooks/pet-grant.json` 里 `"enabled": false` → 改成 `true`
2. 托盘菜单勾上 **「拦下危险操作等我批（kiro）」**（写 `~/.ai-coding-pet/prefs.json` 的 `grantGate`）

### ⚠️ 超时 = 放行（fail-open）

**这跟 claude 内核那边的语义相反**（那边超时=驳回）。原因是 kiro 的 hook 超时行为就是放行，我们改不了；硬做成 fail-closed 只会得到「桌宠一崩，kiro 就干不了活」。

所以明确选择：**宁可漏拦，不可把人锁在门外。** 任何一条不确定都放行：

- 停用开关文件存在 → 放行
- 桌宠没起 / 端口没人听 → 放行（实测立刻返回，不干等）
- 超时（人没管）→ 放行
- 响应看不懂 → 放行

只有明确收到 `deny` 才 `exit 2`。

**一键止血**：`touch ~/.ai-coding-pet/grant.off`。这个开关不依赖桌宠、不依赖改 hook 配置，万一桌宠出问题把 kiro 拖住，用它。删掉文件即恢复。

### 三道减法（否则 kiro 会变得没法用）

请奏是同步阻塞的，每次工具调用都要一次本地 HTTP 往返。所以：

1. **总开关默认关**（上面那两把锁）
2. **hook 的 `matcher` 只匹配写入/执行类工具**，只读调用压根不会走到这儿
3. **到了桌宠再按危险度过一遍**：只有**红档**才真的弹到宠物身上等人，黄/蓝直接放行

「永准」记在内存里（`会话 + 工具` 组合），重启即忘。

### 跟 git-ai 共存

机器上 `~/.kiro/hooks/git-ai-pre.json` / `git-ai-post.json` 挂着同样的触发点（目前 `enabled: false`）。多个 hook 会**都执行**，任何一个 `exit 2` 就拦住。所以桌宠的请奏必须极其克制地只在真该拦时 `exit 2`，否则会跟 git-ai 打架、或者让人搞不清是谁拦的。

---

## hook 清单（都在 `~/.kiro/hooks/`，用户级，对所有 kiro 窗口生效）

| 文件 | 触发点 | kind | 默认 | 干什么 |
|---|---|---|---|---|
| `pet-session-start.json` | SessionStart | `session_start` | 开 | 登记一只宠物 |
| `pet-prompt.json` | UserPromptSubmit | `prompt` | 开 | 切「运行中」+ 取标题 |
| `pet-tool.json` | PreToolUse | `tool_pre` | 开 | 动作计数 + 正在干什么 + 危险度入参 |
| `pet-tool-post.json` | PostToolUse | `tool_post` | 开 | **阅读流主体**（`tool_response`） |
| `pet-grant.json` | PreToolUse | `grant` | **关** | **请奏**，阻塞等批，驳回则 `exit 2` |

`scripts/kiro-pet-hook.py` 的两条铁律没变，只是精确化了一点：

- **绝不影响 kiro 自己的会话**：任何异常都吞掉、超时就放过。退出码只有 `grant` 分支可能是 2，且仅在人明确驳回时。
- **绝不往 stdout 写东西**：`SessionStart` / `UserPromptSubmit` 这类 hook 的 stdout 会被塞进模型上下文，打印任何内容都是在污染对话。驳回理由写 **stderr** —— 那条会被送到 agent 眼前，正是我们想要的。

`pet-tool-post.json` 意味着每次工具调用会多起一个 python 进程（Pre 一个 Post 一个）。这是换阅读流的代价，觉得吵可以把它 `enabled: false`，其余功能不受影响。

---

## 还没做 / 做不到

| 能力 | 状态 |
|---|---|
| 改了哪些文件（`PostFileSave/Create/Delete` → 「改了 3 个文件」） | 没做，触发点是现成的 |
| spec 任务进度（`PreTaskExec/PostTaskExec` → 「任务 3/12」） | **payload 未验证**。这个 workspace 没有 spec，`PreTaskExec` 一次都没触发过，得去有 spec 的工程跑一次才能确认字段 |
| 打断正在跑的 kiro | **做不到**，没有触发点 |
| 从桌宠发指令给 kiro | **做不到**，hook 只能被动响应 |
| assistant 的自然语言旁白 | **做不到**，hook 没有正文触发点 |

---

## 怎么验

不起 Electron 就能跑大部分：`server.js` / `passive-stream.js` / `store.js` / `states.js` 都是纯 Node，hook 是独立进程，所以整条链路能在命令行里真跑一遍（起真 `PetServer` + `execFile` 真跑 hook + 断言退出码与事件）。落地时这样验过 56 项，含所有 fail-open 路径、`exit 2` 拦截、stdout 干净、超大入参截断、stdin 喂垃圾/空/不给参数。

要看真实渲染，起 `AICP_DEBUG=1 npx electron .` 然后 `curl 'http://127.0.0.1:47800/debug?shot=1'` —— 它直接抓渲染层自己画出来的内容，不受 macOS 对高层级窗口截屏策略的影响，是唯一可信的视觉验证途径。想验命中测试用 `/debug-click`。

注意抓出来的图是 2x（Retina），**看可读性必须缩回 1x**，拿 2x 图判断会得出「6 个字也看得清」这种错误结论。另外拼对照图时别横排太多格：曾经拼出一张 2114px 宽的图，读进对话后超过多图请求的 2000px 上限，整个会话被污染到发什么都报错。
