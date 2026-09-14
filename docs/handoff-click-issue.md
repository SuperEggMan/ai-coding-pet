# AI Coding Pet — 宠物点击失效的排查与修复(已结案)

2026-09-07。原文是"点宠物没反应、排查一整轮没结论"的交接文档,现已定位根因并修复,改写为结案记录。**核心结论在第 2 节,后面的人再遇到"窗口收不到鼠标事件"先看那里。**

## 1. 项目是什么

Electron 桌面宠物,给 AI coding agent(Claude Code / kiro / codex / cursor)的每个会话配一只桌宠,状态跟着 agent 走(待命/运行/请奏/请择/瘫倒),在桌宠身上直接看阅读流、发指令、批权限。

- 根目录:`/Users/dt.chen/D/sofaware/myCode/my-skills/ai-coding-pet`
- 启动:`npm start`;`AICP_DEBUG=1` 开渲染层日志,再加 `AICP_DEVTOOLS=1` 才真开 DevTools
- 皮肤:`AICP_SKIN=yunnuo`(frames 形态,AIGC 整图)
- 关键文件:`src/main/{main,windows,server,store,agent}.js`、`src/renderer/{pet,hub}.{js,css,html}`

## 2. 根因:`-webkit-app-region: drag`

`pet.css` 的 `.stage`(宠物本体)上有一行 `-webkit-app-region: drag`。macOS 上 draggable region 的 mousedown 会被**浏览器进程**截去调 `performWindowDragWithEvent:` 做原生窗口拖拽,**渲染层压根收不到 pointerdown / click**。

这一条把当时所有"对不上的证据"全部解释了:

| 现象 | 解释 |
|---|---|
| 真实左键点宠物一次都没触发 `cycleView` | mousedown 在浏览器侧就被吃掉,`el.stage` 的 pointerdown 没跑 |
| 按住拖动却"可以" | 那是**原生**窗口拖拽在干活,不是 `pet.js` 那套 pointer 拖拽 |
| `sendInputEvent` 注入的点击每次都成 | 注入事件直接进 renderer 输入管线,跳过浏览器侧的 draggable region 命中测试 |
| 宝盒窗口点击可靠 | `hub.css` 里一处 `app-region` 都没有 |
| 悬停粉爪时有时无 | drag region 上的鼠标事件不稳定 |
| 层级 / 位置 / 焦点 / 尺寸 / 分屏 / 点穿全试过都没用 | 都不是原因,所以逐个排除也定不了位 |

**教训**:当"注入事件能通、真实事件不通"时,问题几乎一定在**浏览器进程到渲染进程之间的那一层**(draggable region、`setIgnoreMouseEvents`、原生 hit test),不要继续在窗口属性和渲染层逻辑里做排除法。

修复后 `.stage` 显式写 `-webkit-app-region: no-drag` 并留了长注释,防止有人"为了能拖窗口"再加回来——宠物的拖拽由 `pet.js` 自己的 pointerdown/move/up 实现,而且必须自己实现:拖进宝盒回收要靠 pointerup 的屏幕坐标判定,原生拖拽给不了。

## 3. 顺带修掉的三个同族问题

1. **单击丢失的竞态**:`el.stage` 的 pointerdown 原本是 `async` 的,先 `await window.pet.getPos()` 再给 `petDrag` 赋值;而单击判定挂在 pointerup 的 `if (!petDrag) return` 后面。快速点一下会在 IPC 回来前跑完 pointerup,点击直接丢。现在 `petDrag` 同步建好,窗口坐标异步补(`wx===null` 时 pointermove 先不挪)。
2. **回收 `×` 点不动**:pointerdown 里的 `el.stage.setPointerCapture()` 会把后续 pointerup **和随之派发的 click** 一起改派到 stage 上,`#dockBtn` 自己的 click 监听永远收不到。现在 pointerdown 一发现目标是 stage 里的 `button` 就直接放手,不接管、不捕获、不算 tap。
3. **宝盒被拖出屏幕找不回来**:宝盒窗口原来是 600×560,而云糯本体只有 132×132 画在左下角;`hub:set-position` 又没有任何边界约束。抓着云糯往下拖,窗口原点跑到 y=954,云糯落在屏幕坐标 y=1378(屏幕只有 982 高)彻底消失。
   现在:窗口平时只有 `HUB_BOX` 150×156 裹住云糯,菜单摊开时才临时放大到 `HUB_OPEN` 600×560,并锚住**云糯脚下那条线**(`hubAnchor.bottomY`),开合过程中云糯屏幕位置不动;落位一律过 `clampHubAnchor()`,判据是"云糯本体整块可见"而不是"窗口可见"(窗口大部分透明,拿窗口当判据等于允许把云糯推出屏幕),并用 `getDisplayNearestPoint` 支持外接屏。

## 4. 顺带做的产品修正

- **收进宝盒后怎么找回来**:原来只能从菜单栏托盘,跟"收进宝盒"这个说法对不上。现在宝盒菜单的**历史会话**一栏管到底:进行中的会话(含收起来的)点一下把**原来那只**放回桌面(`hub:recall`,sessionId / agent 进程 / 阅读流不变);开工过但现在没会话的目录点一下在那儿开会话。
- **同目录不再开出两只**:`newSession(cwd)` 发现该目录已有在世会话时直接复用,不再 spawn。原来"想找回刚收起来的那只,却从目录列表又开了一只新的"是必踩的坑。
- **docked 用显式集合而不是 `isVisible()`**:窗口是 `show:false` 建的、要等 `ready-to-show` 才显形,那个空档里问一次会把刚建好的宠物误报成"已收起"。改成 `dockedIds` 集合。
- **点开气泡不再把后面的队友往右挤**:气泡是从宠物头顶正上方长出来的,底排只有宠物本体,挤走队友很怪(明明没挡着它)。`windows.js` 新增 `ROW_FOOTPRINT`——排位只按「底排实际占多宽」累加(collapsed/card = 118,chat = 470),窗口宽高仍按 `VIEW_SIZE`。
  这依赖**命中式点穿必须是开着的**:card 档窗口 400×424 会盖住队友的窗口矩形,只有点穿才能让点击精确落到底下那只身上。所以 `windows.create` 恢复了 `setIgnoreMouseEvents(true, { forward: true })`,`pet:interactive` 也恢复按 renderer 报的值走(排障期间被改成常驻可点,那是基于错误结论的将错就错)。
  chat 档仍然让位,因为输入框悬浮在宠物右边、且整个面板全程接管鼠标,底排真的变宽了。
- **「收起」和「关掉」分成两个动作**:原来宠物身上和气泡上的 `×` 其实是"收进宝盒"(只 `win.hide()`,会话继续跑),但 `×` 全世界都读作"关闭",实际使用中真的被误解了。现在:所有回窝键统一 `⤵`(tooltip 写明「会话继续,随时叫回」),气泡的"收起气泡"用 `⌄`;`×` 只出现在会话面板抬头,是**唯一**真的结束会话的键——红色、两步确认(第一下变「结束?」,3 秒回弹),走 `pet:end-session` → `agents.close(id)` + `store.remove(id)`。在这之前 UI 上压根没有主动结束会话的入口,旁路(`ext-`)会话只能等瘫倒被回收,会一直堆在「历史会话」里。
- **多只同时请奏不再有人被埋掉**:同时只允许一只展开(文档结论 1),所以第二、三只被抢走展开位后只剩一个脉动小点,很容易漏。现在 ①状态卡脚注显示「还有 N 只在等」(`snapshot()` 带 `waitingCount`);②当前这只批完后 `_arbitrateExpanded` 自动把展开位交给还在等的下一只,一次批完一串。**只在状态卡档交接**——人正在会话面板里干活时不抢他的屏。
- **尺寸口径**:`pet.css` 的 `--stage`(宠物本体)和 `windows.js` 的 `COLLAPSED/EXPANDED/CHAT`(窗口)必须一起改,换算写在两边注释里:窗口高 = 8 + 面板高 + 8 + `--stage` + 8;折叠态窗口 = `--stage` + 16。宠物 84 明显小于宝盒云糯 132,一眼分得出谁是谁。第一只宠物的横向起点 `HUB_ROW_START = 244` 是按**宝盒菜单右缘**算的(`8 + 216 + 20`),不是按云糯本体——菜单朝上弹、宠物气泡也朝上长,只让开本体就会跟菜单叠在一起。
- **去掉了粉爪假指针**:原来为了播动画隐藏真指针、用 DOM 元素跟随。移除后恢复系统指针(`fake-cursor` / `cursor:none` / `#fakeCursor` 全部删掉)。
- **宝盒渲染层有了报错出口**:`hubWin.webContents.on('console-message')`,以前 `hub.js` 抛异常终端一片安静。
- 菜单文案去掉自造概念:"开一封新奏"→"新会话","叫回云糯"→并进"历史会话"。

## 5. 留下的排障工具

- `AICP_DEBUG=1` 渲染层日志;`AICP_DEVTOOLS=1`(需同时开 DEBUG)才真开 DevTools
- HTTP(`127.0.0.1:47800`,`src/main/server.js`):
  - `GET /debug?shot=1` 全窗口 bounds/可见性 + 各窗口 `capturePage` 存到 `~/.ai-coding-pet/shot-<id>.png`
  - `POST /debug-click {session_id,x,y,double?}` 注入点击。**注意:它只能验证渲染层逻辑,不能替代真实鼠标验证**——本次的 bug 就是"注入能通、真实不通"。`session_id` 可传 `__hub`。
  - `POST /debug-move {session_id,x,y}` / `POST /debug-focus {session_id}`
  - `POST /event`、`POST /view` 造假会话 / 直接切档位
- 常规流程:改代码 → `node --check`(pet.js 是 ESM,用 `node --input-type=module --check < file`)→ `kill $(lsof -ti tcp:47800)` → `nohup env AICP_SKIN=yunnuo npm start > /tmp/pet-dev.log 2>&1 & disown`

**一个验证陷阱**:`AICP_DEBUG=1` 时 `hub.html` 带 `?demo=1`,`hub.js` 会在启动时把菜单和所有二级面板全部展开(方便看排版)。用注入点击去测"点云糯能不能开菜单"时会被它误导——`root.dataset.open` 已经是 `1`,`toggleMenu(true)` 直接翻成关。要测真实开合请去掉 `AICP_DEBUG`。
