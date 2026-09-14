'use strict';

const { app, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { SessionStore } = require('./store');
const { PetServer, HOME } = require('./server');
const { WindowManager, HUB_ROW_START } = require('./windows');
const { S, TIER, classifyGrant, normalizeTool } = require('./states');
const { MobileBridge } = require('./bridge');
const { AgentManager } = require('./agent');
const { PassiveStream } = require('./passive-stream');

const DEMO = process.env.AICP_DEMO === '1';
const DEBUG = process.env.AICP_DEBUG === '1';
const POSES = process.env.AICP_POSES === '1';
const SKIN_ID = process.env.AICP_SKIN || 'yunnuo';

const store = new SessionStore();
const server = new PetServer();
const windows = new WindowManager({ debug: DEBUG });
const agents = new AgentManager();
/* 旁路会话(kiro/codex)的阅读流。桌宠自己驱动的会话由 AgentSession.tail 负责,
   旁路会话没有内核实例,得在这儿单独攒一份,否则会话面板永远是空的。 */
const passive = new PassiveStream();
let bridge = null;
let tray = null;
let hubWin = null;
let hubPosTimer = 0;

/* ---------- 开张宝盒的窗口几何 ----------
   窗口只裹住云糯本体,不留大片透明空白:
   - 空白虽然看不见,却是一块置顶的实体窗口,挡视线、挡点击、还让"拖动"变得
     难以理解(实体在左下角,窗口原点却在几百像素之外,一拽就把云糯甩出屏幕)。
   - 菜单要摊开时才临时把窗口放大,并且锚住云糯脚下那条线(bottom-left),
     所以云糯的屏幕位置在开合之间不动 —— 跟宠物窗口同一套做法。
   hub.css 里 `.hub{left:8px;bottom:4px}` + `.box{132x132 占位}` 决定了下面这些数字。
   云糯常态收小到 96、hover/开菜单放大回 132(纯 CSS transform,原点在左下基准线);
   窗口占位(.box)按放大态 132 留够,但拖回收热区 / 排位锚点按「常态 96」算——
   放大只是视觉反馈,不该改变点击与拖拽判定。改 96/132 要同步 hub.css 的 .box / .box-scale。 */
const HUB_BOX = { width: 150, height: 156 }; // 折叠:只有云糯(按放大态 132 留够 + 一点余量)
const HUB_OPEN = { width: 600, height: 560 }; // 菜单 + 二级菜单摊开
const HUB_MASCOT = { inset: 8, bottom: 4, size: 96 }; // 云糯常态在窗口里的位置(hover 放大不改这个)
let hubMenuOpen = false;
/**
 * 被「收进宝盒」的会话 id。
 * 不用 win.isVisible() 反推:窗口是 show:false 建的、要等 ready-to-show 才显形,
 * 那个空档里问一次就会把刚建好的宠物误报成"已收起"(实测踩过)。
 */
const dockedIds = new Set();
/** 云糯脚下那条线(窗口 bottom-left 的屏幕坐标),窗口缩放全靠它锚住 */
let hubAnchor = { x: 0, bottomY: 0 };

function hubSize() {
  return hubMenuOpen ? HUB_OPEN : HUB_BOX;
}

function hubBounds() {
  const size = hubSize();
  return { x: hubAnchor.x, y: hubAnchor.bottomY - size.height, ...size };
}

/** 云糯本体在屏幕上的矩形(拖拽约束、宠物排位、拖回判定都以它为准) */
function hubMascotRect() {
  return {
    x: hubAnchor.x + HUB_MASCOT.inset,
    y: hubAnchor.bottomY - HUB_MASCOT.bottom - HUB_MASCOT.size,
    w: HUB_MASCOT.size,
    h: HUB_MASCOT.size,
  };
}

/**
 * 把锚点收进可视区:判据是「云糯本体整块可见」,不是窗口可见——
 * 窗口大部分是透明的,拿窗口当判据等于允许把云糯推到屏幕外。
 * 用 getDisplayNearestPoint 而不是主屏,外接显示器上也能放。
 */
function clampHubAnchor(x, bottomY) {
  const { screen } = require('electron');
  const fallbackWa = screen.getPrimaryDisplay().workArea;
  const ax = Number.isFinite(x) ? x : fallbackWa.x + 14;
  const ab = Number.isFinite(bottomY) ? bottomY : fallbackWa.y + fallbackWa.height - 14;
  const wa = screen.getDisplayNearestPoint({
    x: Math.round(ax + HUB_MASCOT.inset + HUB_MASCOT.size / 2),
    y: Math.round(ab - HUB_MASCOT.bottom - HUB_MASCOT.size / 2),
  }).workArea;

  const minX = wa.x - HUB_MASCOT.inset;
  const maxX = wa.x + wa.width - HUB_MASCOT.inset - HUB_MASCOT.size;
  const minBottom = wa.y + HUB_MASCOT.bottom + HUB_MASCOT.size;
  const maxBottom = wa.y + wa.height + HUB_MASCOT.bottom;
  return {
    x: Math.round(Math.min(Math.max(ax, minX), Math.max(minX, maxX))),
    bottomY: Math.round(Math.min(Math.max(ab, minBottom), Math.max(minBottom, maxBottom))),
  };
}

/** 按当前档位落位宝盒窗口(锚住云糯脚下那条线),并让宠物队形跟着重排 */
function applyHubBounds() {
  if (!hubWin || hubWin.isDestroyed()) return;
  hubWin.setBounds(hubBounds(), false);
  windows._layoutAll();
  raiseHub();
}

/** 宝盒是入口,必须压在宠物之上,否则宠物一展开就把它盖住 */
function raiseHub() {
  if (!hubWin || hubWin.isDestroyed() || !hubWin.isVisible()) return;
  hubWin.moveTop();
}

/**
 * 会话增删/收起/叫回时通知宝盒重画「历史会话」那一栏。
 * 只在这几个时刻推,不跟 tick 走 —— 那是每秒一次,没必要。
 */
function notifyHubSessions() {
  if (!hubWin || hubWin.isDestroyed()) return;
  hubWin.webContents.send('hub:sessions-changed');
}

/* ---------- 最近开工目录(默认目录 + 历史二级菜单的数据源) ---------- */
const RECENTS_FILE = path.join(HOME, 'recent-dirs.json');
const MAX_RECENTS = 20; // 临时工作目录也记在这里,所以留得宽一点
const PREFS_FILE = path.join(HOME, 'prefs.json');

function loadPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function savePrefs(patch) {
  const next = { ...loadPrefs(), ...patch };
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(PREFS_FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (err) {
    console.warn('[pet] 保存偏好失败:', err.message);
  }
}

function clientPref() {
  return loadPrefs().client || 'kiro'; // 默认 kiro
}

/* ============================================================
   请奏闸门（旁路会话专用）

   背景:kiro 的 `PreToolUse` hook 用 exit 2 **真的能拦住工具执行**,所以
   「在桌宠上准奏/驳回」对 kiro 是做得到的 —— 桌宠侧的阻塞审批通道
   (/permission + /decision + 准奏/永准/驳回 UI)早就为旁路协议建好了。

   但它是同步阻塞的,每次工具调用都要一次本地 HTTP 往返。所以要设三道减法,
   否则 kiro 会变得没法用:
     ① 总开关默认**关**。请奏会动 kiro 的执行路径,不该由我们替用户默默打开,
        在托盘菜单里显式勾选才生效。
     ② hook 的 matcher 只匹配写入/执行类工具,只读调用压根不会走到这儿。
     ③ 到了这儿再按危险度过一遍:只有**红档**(命中破坏性特征)才真的弹到
        宠物身上等人,黄/蓝直接放行。

   还有一条语义必须记牢并且在界面上说清:**超时 = 放行(fail-open)**。
   kiro 的 hook 超时行为是放行,我们改不了;硬做成 fail-closed 只会得到
   「桌宠一崩 kiro 就干不了活」。这跟 claude 内核那边「超时=驳回」相反。
   ============================================================ */

/** 落过「永准」的 (会话, 工具) 组合,后续不再问。只活在内存里,重启即忘。 */
const alwaysAllow = new Set();

function grantGateOn() {
  return loadPrefs().grantGate === true;
}

function alwaysKey(body) {
  return `${body.session_id || ''}|${normalizeTool(body.tool)}`;
}

/**
 * 决定这次请奏要不要真的打扰人。
 * @returns {{decision: string, note: string}|null} null = 落到宠物身上阻塞等人
 */
function grantVerdict(body) {
  if (DEMO) {
    // 演示模式:剧本里的 demo- 会话请奏一律「真阻塞等人批」——不看 grantGate、
    // 不看危险度,因为演示的核心就是把审批弹出来给人看(蓝奏也要能弹,否则镜头 4
    // 的「并发多会话审批」演不出来)。返回 null = 落到宠物身上阻塞。
    // 非 demo- 会话(你自己真实的 kiro)则直接放行,别混进演示画面、也别挂在这儿等批。
    if (String((body && body.session_id) || '').startsWith('demo-')) return null;
    return { decision: 'allow', note: 'demo-bypass' };
  }
  if (!grantGateOn()) return { decision: 'allow', note: 'gate-off' };
  if (alwaysAllow.has(alwaysKey(body))) return { decision: 'allow', note: 'always' };
  const { tier } = classifyGrant(body.tool, body.input);
  if (tier !== TIER.RED) return { decision: 'allow', note: `tier-${tier}` };
  return null;
}

/**
 * 最近开工目录。**顺手剔掉已经不存在的目录** ——
 * 目录被删/改名后留在列表里,点它 `hub:open-dir` 只会静默返回 false,
 * 表现就是"点了没反应",而且完全看不出原因(实测踩过)。
 */
function loadRecents() {
  try {
    const arr = JSON.parse(fs.readFileSync(RECENTS_FILE, 'utf8'));
    if (!Array.isArray(arr)) return [];
    return arr.filter((p) => typeof p === 'string' && p && fs.existsSync(p));
  } catch {
    return [];
  }
}

function saveRecent(dir) {
  if (!dir) return;
  const list = [dir, ...loadRecents().filter((p) => p !== dir)].slice(0, MAX_RECENTS);
  try {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(RECENTS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch (err) {
    console.warn('[pet] 记录最近目录失败:', err.message);
  }
}

// 同一台机器只允许一个实例，否则 hook 端口会抢
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  // 菜单栏应用形态：不要 Dock 图标，不要主窗口
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  app.whenReady().then(async () => {
    server.setSnapshotSource(() => store.snapshot());
    server.setDebugSource((params) => debugReport(params));
    server.setGrantPolicy((body) => grantVerdict(body));
    server.on('decided', ({ decision, body }) => {
      // 「永准」= 这个会话里这个工具以后别再问了
      if (decision === 'always' && body && body.tool) alwaysAllow.add(alwaysKey(body));
    });
    server.on('event', (raw) => {
      // 演示模式下把真实 kiro 的 hook 事件挡在门外。
      // 只跳过 kiro 扫描是不够的：hook 是本机全局装的，会照样往 /event 打，
      // 于是舞台上除了剧本里的三只还会冒出你自己正在跑的会话（实测 5 只），
      // 录出来一片乱。剧本里的 session_id 一律以 demo- 开头，据此放行。
      if (DEMO && !String((raw && raw.session_id) || '').startsWith('demo-')) return;
      try {
        const s = store.apply(raw);
        // 顺手把这条事件转成阅读流条目。必须用 store 归一后的 s.id:
        // 旁路上报的 session_id 会被 _resolveId 认领到别只宠物身上,
        // 直接拿 raw.session_id 会把内容写进隔壁那只的流里。
        if (s) {
          const items = passive.ingest(raw, s.id);
          if (items.length) windows.send(s.id, 'pet:transcript', items);
        }
      } catch (err) {
        console.error('[pet] apply event failed:', err, raw);
      }
    });
    server.on('transcript', ({ sessionId, items }) => {
      windows.send(sessionId, 'pet:transcript', items);
    });
    server.on('view', ({ sessionId, view }) => {
      if (view === 'collapsed') store.setExpanded(null);
      else store.setExpanded(sessionId, view === 'chat' ? 'chat' : 'card');
    });
    // 排障:强制激活应用+窗口,排查"accessory 应用没被激活导致首次真实点击进不来"
    server.on('debug-focus', ({ sessionId }) => {
      const win = windows.get(sessionId);
      if (!win || win.isDestroyed()) return;
      app.focus({ steal: true });
      win.show();
      win.focus();
    });
    // 排障:把某只宠物窗口挪到指定屏幕坐标(排查是否被别的置顶窗口占位)
    server.on('debug-move', ({ sessionId, x, y }) => {
      const win = windows.get(sessionId);
      if (win && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y), false);
    });
    // 排障:在窗口内坐标模拟一次真实点击,不走系统辅助功能权限
    server.on('debug-click', ({ sessionId, x, y, double }) => {
      const win = windows.get(sessionId);
      if (!win || win.isDestroyed()) return;
      const wc = win.webContents;
      wc.sendInputEvent({ type: 'mouseMove', x, y });
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      if (double) {
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 2 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 2 });
      }
    });

    let port;
    try {
      port = await server.listen();
    } catch (err) {
      console.error('[pet] 端口占用，无法启动状态入口:', err.message);
      app.quit();
      return;
    }
    console.log(`[pet] state endpoint  http://127.0.0.1:${port}`);

    bridge = new MobileBridge({ store });
    try {
      const info = await bridge.listen();
      console.log(`[pet] mobile bridge   ${info.url}`);
    } catch (err) {
      console.warn('[pet] mobile bridge 未启动:', err.message);
    }

    // 有 agent 内核 = 能在桌宠里发指令;旁路会话(kiro/codex)只能看
    store.setCommandable((id) => Boolean(agents.get(id)));

    wireStore();
    wireIpc();
    wireAgents();
    buildTray();
    store.start();
    // 平时桌面放一朵「开张宝盒」;演示/检查台模式不打扰
    if (!DEMO && !POSES) openHub();

    // 演示模式没有宝盒,默认会退回「屏幕右下角向左排」。但录 demo 要宠物在
    // 屏幕**左侧**(讲解/字幕通常压在右边)。注入一个左下角的虚拟锚点,让宠物
    // 走 setAnchor 那条「从锚点向右排」的分支,从左边起、向右一字排开。
    if (DEMO) {
      const { screen } = require('electron');
      const wa = screen.getPrimaryDisplay().workArea;
      windows.setAnchor(() => ({
        x: wa.x + 16 - HUB_ROW_START, // 抵消 _rowBounds 里的 +HUB_ROW_START,让第一只贴左边距 16 起
        bottomY: wa.y + wa.height - 16,
      }));
      // 录制模式(pitch)铺一块干净的演播背景,盖住工作环境(Kiro/终端),
      // 这样全屏录也不露桌面。背景窗**先于宠物创建、且不 moveTop**,宠物
      // 在展开时会 moveTop 到它上面,所以宠物永远站在这块画布之上。
      if (process.env.AICP_PITCH === '1') openDemoBackdrop(wa);
    }

    // 本机 kiro 会话自动同步:启动扫一次 → 之后靠监听库变化触发 → 兜底再加一层慢轮询
    if (!DEMO && !POSES) {
      tickKiroScan();
      watchKiroStorage();
      kiroScanTimer = setInterval(tickKiroScan, KIRO_SCAN_FALLBACK_MS);
      if (kiroScanTimer.unref) kiroScanTimer.unref();

    }

    if (POSES) {
      openPoseSheet();
    } else if (DEMO) {
      // 走真实 HTTP 通道，把 hook 入口→状态机→窗口→渲染→阻塞审批整条链跑一遍。
      // AICP_PITCH=1 换成录视频用的慢节奏剧本（scripts/demo-pitch.js）。
      const script = process.env.AICP_PITCH === '1' ? '../../scripts/demo-pitch' : '../../scripts/demo';
      require(script).run({ port }).catch((e) => console.error('[demo]', e));
    }
  });

  app.on('window-all-closed', () => {
    // 桌宠是常驻的，窗口全关掉也不退出
  });

  app.on('before-quit', async () => {
    clearInterval(kiroScanTimer);
    clearTimeout(kiroDebounce);
    if (kiroWatcher) kiroWatcher.close();
    store.stop();
    windows.destroyAll();
    await agents.closeAll();
    if (bridge) await bridge.close();
    await server.close();
  });
}

function wireStore() {
  store.on('add', (s) => {
    windows.create(s.id);
    raiseHub(); // 新宠物窗口会压在最上面,宝盒得再抬一次
    notifyHubSessions();
  });

  store.on('change', (s) => {
    if (!windows.has(s.id)) windows.create(s.id);
    pushState(s.id);
  });

  store.on('expanded', ({ id, view, prev }) => {
    if (prev && prev !== id) {
      windows.setView(prev, 'collapsed');
      pushState(prev);
    }
    if (id) {
      windows.setView(id, view || 'card');
      pushState(id);
      // 会话面板要能打字，必须真的拿到焦点
      if (view === 'chat') windows.focus(id);
      raiseHub(); // 展开会 moveTop,别把宝盒盖住
    }
  });

  store.on('remove', (s) => {
    dockedIds.delete(s.id);
    passive.drop(s.id); // 宠物没了,它那份阅读流也别攒着
    windows.destroy(s.id);
    refreshTray();
    notifyHubSessions();
  });

  store.on('tick', () => {
    // 运行时长要每秒走字，所以每 tick 都推一次快照
    for (const s of store.sessions.values()) pushState(s.id);
    refreshTray();
  });
}

function pushState(id) {
  const s = store.get(id);
  if (!s) return;
  const snap = store.snapshot().find((x) => x.id === id);
  if (snap) windows.send(id, 'pet:state', snap);
  if (bridge) bridge.push();
}

/* 「去 xxx」按钮:把只能看的会话跳回它真正的客户端 */
const REVEAL_APPS = { kiro: 'Kiro', cursor: 'Cursor', codex: 'Visual Studio Code' };

/**
 * 找客户端自带的 CLI(`<App>.app/Contents/Resources/app/bin/<name>`)。
 * 各家名字不一样(Kiro 里那个居然叫 `code`),所以扫目录而不是硬编码。
 */
function revealCli(appName) {
  const dir = `/Applications/${appName}.app/Contents/Resources/app/bin`;
  try {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (!fs.statSync(p).isFile()) continue;
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {
        /* 不可执行,看下一个 */
      }
    }
  } catch {
    /* 这个 app 没带 CLI */
  }
  return null;
}

function wireIpc() {
  ipcMain.handle('pet:load-skin', () => loadSkin(SKIN_ID));

  ipcMain.on('pet:ready', (_e, sessionId) => {
    pushState(sessionId);
    // 窗口可能是后建的，把已经产生的阅读流补给它，否则面板一片空白。
    // 旁路会话没有 agent 实例，走 passive 那份 tail。
    const agent = agents.get(sessionId);
    const tail = agent && agent.tail.length ? agent.tail : passive.tailOf(sessionId);
    if (tail.length) windows.send(sessionId, 'pet:transcript', tail);
  });

  ipcMain.on('pet:interactive', (_e, { sessionId, interactive }) => {
    windows.setInteractive(sessionId, Boolean(interactive));
  });

  ipcMain.on('pet:cycle-view', (_e, { sessionId }) => {
    store.cycleExpanded(sessionId);
  });

  ipcMain.on('pet:set-view', (_e, { sessionId, view }) => {
    if (view === 'collapsed') store.setExpanded(null);
    else store.setExpanded(sessionId, view === 'chat' ? 'chat' : 'card');
  });

  /* ---------- 交互：优先走 agent 内核，退化到 HTTP 审批通道 ---------- */

  ipcMain.on('pet:send', (_e, { sessionId, text }) => {
    const agent = agents.get(sessionId);
    if (!agent) return;
    agent.send(text);
  });

  ipcMain.on('pet:interrupt', (_e, { sessionId }) => {
    const agent = agents.get(sessionId);
    if (agent) agent.interrupt();
  });

  ipcMain.on('pet:permission-mode', (_e, { sessionId, mode }) => {
    const agent = agents.get(sessionId);
    if (agent) agent.setPermissionMode(mode);
  });

  ipcMain.on('pet:decide', (_e, { sessionId, decision }) => {
    const s = store.get(sessionId);
    if (!s || !s.pending || s.pending.kind !== 'grant') return;
    const agent = agents.get(sessionId);
    if (agent && agent.decide(s.pending.requestId, decision)) return;
    // 旁路模式（外部 agent 通过 HTTP 上报）仍然走原来的阻塞通道
    server.resolvePermission(s.pending.requestId, decision, 'desktop-pet');
  });

  ipcMain.on('pet:choose', (_e, { sessionId, index }) => {
    const s = store.get(sessionId);
    if (!s || !s.pending || s.pending.kind !== 'choice') return;
    const opt = (s.pending.options || [])[index];
    const agent = agents.get(sessionId);
    if (agent && agent.choose(s.pending.requestId, String(opt ?? index))) return;
    server.resolvePermission(s.pending.requestId, 'allow', `choice:${opt ?? index}`);
  });

  ipcMain.on('pet:ack', (_e, { sessionId }) => {
    store.acknowledge(sessionId);
  });

  /**
   * 结束会话 —— 跟「收进宝盒」是两件事:
   *   收进宝盒 = 只藏窗口,会话继续跑,随时从「历史会话」叫回来
   *   结束会话 = 会话真的没了,宠物窗口销毁,「历史会话」里只剩那个目录
   * 有内核的(claude)连 agent 进程一起关;旁路会话(ext-)只去掉桌宠这边的记录。
   */
  ipcMain.on('pet:end-session', (_e, { sessionId }) => endSession(sessionId));

  /* ---------- 宠物拖动 / 收回宝盒 ---------- */
  ipcMain.handle('pet:get-position', (_e, sessionId) => {
    const win = windows.get(sessionId);
    return win && !win.isDestroyed() ? win.getPosition() : [0, 0];
  });
  ipcMain.on('pet:set-position', (_e, { sessionId, x, y }) => {
    const win = windows.get(sessionId);
    if (win && !win.isDestroyed() && Number.isFinite(x) && Number.isFinite(y)) {
      win.setPosition(Math.round(x), Math.round(y), false);
    }
  });
  ipcMain.handle('pet:hub-zone', () => {
    if (!hubWin || hubWin.isDestroyed() || !hubWin.isVisible()) return null;
    // 直接给云糯本体的矩形,不再按固定窗口高度硬算(窗口现在会随菜单开合变高)
    return hubMascotRect();
  });
  ipcMain.on('pet:dock', (_e, { sessionId }) => {
    // 收进宝盒:窗口藏起来,会话保留;同时释放排位,让新会话从最左空位排
    const win = windows.get(sessionId);
    if (win && !win.isDestroyed() && win.isVisible()) {
      win.hide();
      dockedIds.add(sessionId);
      windows.freeSlot(sessionId);
      notifyHubSessions(); // 收起来了,「历史会话」那一栏的状态得跟上
      // 宠物钻进窝里,宝盒那边冒一小朵云接住它
      if (hubWin && !hubWin.isDestroyed()) hubWin.webContents.send('hub:puff');
    }
  });

  /** 只能看的会话:跳到它真正的客户端里去说话 */
  ipcMain.on('pet:reveal', (_e, { sessionId }) => {
    const s = store.get(sessionId);
    if (!s || !s.cwd) return;
    const app = REVEAL_APPS[s.agent];
    if (!app) return;
    const cli = revealCli(app);
    /*
     * 必须走客户端自带的 CLI,不能用 `open -a`。
     * `open -a Kiro <dir>` 会**再开一个窗口**,哪怕这个目录已经开着(实测踩过)。
     * VS Code 系的 CLI 传目录进去,目录已开着就聚焦那个窗口 —— 这才是"跳过去"。
     * 注意别加 `-r/--reuse-window`:那是"拿最后活跃的窗口装这个目录",会把
     * 人家正开着的工程顶掉。
     */
    const [bin, args] = cli ? [cli, [s.cwd]] : ['open', ['-a', app, s.cwd]];
    require('child_process').execFile(bin, args, (err) => {
      if (err) console.warn('[pet] 跳到', app, '失败:', err.message);
    });
  });

  ipcMain.on('pet:log', (_e, { sessionId, args }) => {
    if (DEBUG) console.log(`[renderer ${sessionId}]`, ...args);
  });

  /* ---------- 开张宝盒 ---------- */
  ipcMain.handle('hub:pick-folder', async () => Boolean(await pickFolderAndStart()));
  ipcMain.handle('hub:options', () => {
    return {
      defaultDir: nextScratchDir(),
      recents: loadRecents(),
      client: clientPref(),
      scratchBase: scratchBase(), // 渲染层据此判断哪些行是"临时目录",只给它们删除键
      /*
       * 桌宠能不能自己起一个会话。
       * 只有 claude 能:它是原生内核(Claude Agent SDK)。kiro / codex / cursor
       * 是**单向观测** —— 桌宠没有办法让 kiro 开一个会话,会话只能在 kiro 里开。
       * 所以选了它们的时候「新会话」整块要藏掉:留一个按不出东西的入口,
       * 用户只会以为是坏了。宠物靠自动同步(kiro-scan)自己冒出来。
       */
      canCreate: clientPref() === 'claude',
    };
  });
  /**
   * 双击云糯:建一块新地方(mkdir -p)再开会话。
   * 目录是现造的,所以一定走「新建」分支,不会撞上 newSession 的同目录复用。
   * 临时目录也记进最近目录(上限 20),所以它们会出现在「历史会话」里,
   * 用完可以在那儿手动删掉(见 hub:trash-dir)。
   */
  ipcMain.handle('hub:quick-new', async () => {
    const dir = nextScratchDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.error('[pet] 建新会话目录失败:', dir, err && err.message);
      return { ok: false, mkdirFailed: true, dir };
    }
    const r = await newSession(dir);
    return { ok: Boolean(r), dir };
  });
  ipcMain.handle('hub:set-client', (_e, client) => {
    const allow = ['kiro', 'claude', 'codex', 'cursor'];
    if (!allow.includes(client)) return false;
    savePrefs({ client });
    refreshTray();
    return true;
  });
  ipcMain.handle('hub:open-dir', async (_e, dir) => {
    // 目录没了要如实说,不能静默失败 —— 渲染层据此重画列表把死条目抹掉
    if (typeof dir !== 'string' || !fs.existsSync(dir)) return { ok: false, gone: true };
    // 必须 await:newSession 是 async,`Boolean(promise)` 恒为 true,失败也会报成功。
    // reused 要透给渲染层——复用时不该冒「开张」那朵云,那是骗人。
    const r = await newSession(dir);
    return { ok: Boolean(r), reused: Boolean(r && r.reused) };
  });
  /** 把某个目录从「最近目录」里划掉,磁盘上一个字节都不动 */
  ipcMain.handle('hub:forget-dir', (_e, dir) => {
    if (typeof dir !== 'string' || !dir) return false;
    const next = loadRecents().filter((p) => p !== dir);
    try {
      fs.writeFileSync(RECENTS_FILE, JSON.stringify(next, null, 2), 'utf8');
    } catch (err) {
      console.warn('[pet] 更新最近目录失败:', err.message);
      return false;
    }
    return true;
  });

  /**
   * 删掉一个临时工作目录。
   * 三重护栏,别让这个键变成一把误伤真实工程的刀:
   *   ① 只允许删 scratchBase 底下的目录(path.relative 判包含,挡穿越)
   *   ② 该目录上还有在世会话时不删
   *   ③ 用 shell.trashItem 移到废纸篓,不用 rm -rf —— 里面可能有 agent 写出来的
   *      真东西,删错了要能捞回来
   */
  ipcMain.handle('hub:trash-dir', async (_e, dir) => {
    if (!isScratchDir(dir)) return { ok: false, reason: 'not-scratch' };
    if (store.list().some((s) => s.cwd === dir)) return { ok: false, reason: 'in-use' };
    try {
      if (fs.existsSync(dir)) await shell.trashItem(dir);
    } catch (err) {
      console.warn('[pet] 移入废纸篓失败:', dir, err && err.message);
      return { ok: false, reason: 'trash-failed' };
    }
    const next = loadRecents().filter((p) => p !== dir);
    try {
      fs.writeFileSync(RECENTS_FILE, JSON.stringify(next, null, 2), 'utf8');
    } catch {
      /* 目录已经没了,loadRecents 下次读会自动剔掉 */
    }
    return { ok: true };
  });

  /**
   * 在世的会话清单(给宝盒「历史会话」那一栏用)。
   * 「收进宝盒」只是把窗口 hide 掉、会话还在,所以必须有一条把它叫回来的路
   * ——不然收起来的宠物只能从菜单栏托盘找回,跟"收进宝盒"这个说法对不上。
   */
  ipcMain.handle('hub:sessions', () => {
    return store.list().map((s) => {
      const win = windows.get(s.id);
      return {
        id: s.id,
        project: s.project || path.basename(s.cwd || '') || s.agent || s.id,
        cwd: s.cwd || '',
        agent: s.agent || '',
        stateLabel: labelOf(s.state),
        docked: dockedIds.has(s.id) || !win || win.isDestroyed(),
      };
    });
  });
  /** 从宝盒「历史会话」里直接结束某个会话(收起来的也能直接结,不用先叫回来) */
  ipcMain.handle('hub:end-session', async (_e, sessionId) => endSession(sessionId));

  /** 把某个会话的宠物放回桌面:窗口重新排位显示,并弹出气泡 */
  ipcMain.handle('hub:recall', (_e, sessionId) => {
    if (!store.get(sessionId)) return false;
    openNewSessionChat(sessionId);
    notifyHubSessions();
    return true;
  });
  ipcMain.on('hub:hide', () => {
    if (hubWin) {
      hubWin.hide();
      refreshTray();
    }
  });
  ipcMain.handle('hub:get-position', () => {
    if (!hubWin) return [0, 0];
    return hubWin.getPosition();
  });
  ipcMain.on('hub:set-position', (_e, { x, y }) => {
    if (!hubWin || typeof x !== 'number' || typeof y !== 'number') return;
    // 绝对坐标直达,不做增量,拖拽才跟手不漂移;但必须夹一下,
    // 不然云糯能被拖出屏幕彻底找不回来(实测踩过:窗口 y=954 时云糯在 y=1378)
    hubAnchor = clampHubAnchor(x, y + hubSize().height);
    applyHubBounds();
    // 防抖记位置:下次启动停回这里(存窗口左上角,启动时再夹一次)
    clearTimeout(hubPosTimer);
    hubPosTimer = setTimeout(() => {
      const b = hubBounds();
      savePrefs({ hubPos: { x: b.x, y: b.y } });
    }, 400);
  });
  /** 菜单开合 → 窗口在「只裹云糯」和「摊开菜单」两档之间缩放 */
  ipcMain.handle('hub:menu', (_e, open) => {
    const next = Boolean(open);
    if (next === hubMenuOpen) return true; // 关菜单会被多处重复调用,别反复重排
    hubMenuOpen = next;
    // 菜单和宠物气泡都是朝上长的,会抢同一片屏幕。宝盒是"顺手用一下"的入口,
    // 所以开菜单时先把气泡收起来 —— 这样宠物就能一直紧挨着宝盒站,
    // 不用为了永远让开菜单而被推远(那样平时全在浪费桌面)。
    // 会话面板(chat)不动:那是人正在里面打字干活的地方,靠宝盒压在上层解决遮挡。
    if (next && store.expandedId && store.expandedView === 'card') store.setExpanded(null);
    applyHubBounds();
    return true;
  });
  ipcMain.on('hub:interactive', (_e, { interactive }) => {
    if (!hubWin) return;
    hubWin.setIgnoreMouseEvents(!interactive, { forward: true });
  });
}

/* ============================================================
   Agent 会话
   ============================================================ */

function wireAgents() {
  // agent 产出的事件沿用 store 既有词汇，状态机 / 位姿 / 窗口逻辑一行都不用改
  agents.on('event', (ev) => {
    try {
      store.apply(ev);
    } catch (err) {
      console.error('[pet] agent event failed:', err, ev);
    }
  });

  agents.on('transcript', ({ sessionId, items }) => {
    windows.send(sessionId, 'pet:transcript', items);
  });

  agents.on('session-error', ({ sessionId, err }) => {
    console.error(`[agent ${sessionId}]`, err && err.message);
  });

  agents.on('stderr', ({ sessionId, data }) => {
    if (DEBUG) console.log(`[agent ${sessionId} stderr] ${String(data).trimEnd()}`);
  });
}

/* ---------- 自动同步本机 kiro 会话 ----------
   scripts/kiro-scan.py 逆向读 kiro 的 workspaceStorage,盘点「当前开着哪些窗口、
   每个窗口有哪些会话面板」。

   时效实测:kiro 是「有变化就立刻写」,改一次会话标题不到 1 秒就落进 state.vscdb。
   所以 30 秒一轮的盘点足够跟手 —— 之前以为是"攒批落盘、分钟级",那是把
   `quietSec`(窗口多久没变化)误读成了"数据有多旧"。

   它仍然只负责**名单**:运行中/请奏这些状态库里没有,靠
   scripts/kiro-pet-hook.py 那条 hook 通道。两条道用 cwd / kiroSessionId 归一。 */
const KIRO_SCAN = path.join(__dirname, '..', '..', 'scripts', 'kiro-scan.py');
/*
   为什么是「监听 + 防抖」而不是定时轮询:
   实测一次扫描 ~80ms,要复制 3 个库共 ~1MB。真按 200ms 一轮 = 每秒 5.2MB 复制、
   每天 435GB 写盘、一个核常占 40% —— 为了"注意到多了个会话面板"烧成这样不值。
   kiro 写库是即时的(改标题 <1s 落盘),所以盯着库变化再扫,反应一样快,
   闲着时一次都不扫。
*/
const KIRO_SCAN_DEBOUNCE = 200; // 库变了等这么久再扫,合并连续写入
const KIRO_SCAN_MIN_GAP = 800; // 两次扫描最小间隔,挡住写库风暴(布局/终端状态也会写同一个库)
const KIRO_SCAN_FALLBACK_MS = 30000; // 兜底轮询:watcher 万一失效不至于全瞎
let kiroScanTimer = 0;
let kiroWatcher = null;
let kiroDebounce = 0;
let kiroScanning = false;
let lastScanAt = 0;
let lastKiroScan = { at: 0, windows: [], scans: 0 };

function runKiroScan() {
  return new Promise((resolve) => {
    require('child_process').execFile(
      'python3',
      [KIRO_SCAN],
      { timeout: 8000, maxBuffer: 1 << 20 },
      (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * 把盘点结果并进 store。
 *
 * 只做加法,**不主动删**:库有延迟,"扫不到"很可能只是还没刷盘,不能据此把
 * 用户正看着的宠物撤掉。唯一的例外是从没收到过任何 hook 事件、也还停在待命的
 * 那些(纯扫出来的空壳),窗口关了就跟着收掉,不然会攒一堆僵尸。
 */
function syncKiroSessions(scan) {
  if (!scan || !Array.isArray(scan.windows)) return;
  lastKiroScan = { at: Date.now(), windows: scan.windows, scans: lastKiroScan.scans + 1 };

  const seen = new Set();
  for (const w of scan.windows) {
    for (const k of w.sessions || []) {
      seen.add(k.id);
      // `x.id === k.id` 那一支:hook 比扫描先到时,宠物是用原始 sess_ id 建的
      const exist = store.list().find((x) => x.kiroSessionId === k.id || x.id === k.id);
      if (exist) {
        exist.kiroSessionId = k.id;
        // 标题在 kiro 那边改了就跟上;但别覆盖 hook 报上来的更实时的标题
        if (k.title && !exist.adopted && exist.title !== k.title) {
          exist.title = k.title;
          store.emit('change', exist, { transitioned: false });
        }
        exist.kiroFocused = Boolean(k.focused);
        continue;
      }
      // ext- 前缀:渲染层据此认定"旁路会话,没有内核,输入框不可用"
      const sid = `ext-ks-${k.id.replace(/^sess_/, '').slice(0, 8)}`;
      if (store.get(sid)) continue;
      const s = store.apply({
        session_id: sid,
        kiro_session_id: k.id, // 必须带上:让 _resolveId 走精确匹配,别被 cwd 猜测劫持
        kind: 'session_start',
        agent: 'kiro',
        cwd: w.folder,
        project: path.basename(w.folder) || w.folder,
        title: k.title || '',
      });
      if (s && s.id !== sid) {
        // 被认领到别的宠物身上了(比如宝盒的占位):那就不是新建,别去改它的归属
        s.kiroFocused = Boolean(k.focused);
        continue;
      }
      if (s) {
        s.kiroSessionId = k.id;
        s.kiroFocused = Boolean(k.focused);
      }
    }
  }

  for (const s of store.list()) {
    if (!s.kiroSessionId || seen.has(s.kiroSessionId)) continue;
    if (!s.adopted && s.state === S.IDLE) store.remove(s.id); // 纯空壳,窗口关了就收
  }
}

async function tickKiroScan() {
  if (kiroScanning) return; // 上一轮还没回来,别叠罗汉
  kiroScanning = true;
  lastScanAt = Date.now();
  try {
    syncKiroSessions(await runKiroScan());
  } finally {
    kiroScanning = false;
  }
}

/** 库变了 → 防抖后扫一次,并保证两次扫描间隔不小于 MIN_GAP */
function requestKiroScan() {
  clearTimeout(kiroDebounce);
  const gap = KIRO_SCAN_MIN_GAP - (Date.now() - lastScanAt);
  kiroDebounce = setTimeout(tickKiroScan, Math.max(KIRO_SCAN_DEBOUNCE, gap));
  if (kiroDebounce.unref) kiroDebounce.unref();
}

/**
 * 盯住 kiro 的 workspaceStorage。
 * 递归监听根目录:开新窗口会在这儿多出一个 hash 子目录,改会话面板会写
 * `<hash>/state.vscdb` —— 两件事都能捕到。
 * 拿不到 watcher(权限/平台差异)就退回兜底轮询,不影响功能只是慢一点。
 */
function watchKiroStorage() {
  const root = path.join(require('os').homedir(), 'Library/Application Support/Kiro/User/workspaceStorage');
  if (!fs.existsSync(root)) return false;
  try {
    kiroWatcher = fs.watch(root, { recursive: true }, (_ev, name) => {
      // 会话面板只存在这一份库里;编辑器布局之类也写它,多扫几次无所谓
      if (name && !String(name).includes('state.vscdb')) return;
      requestKiroScan();
    });
    kiroWatcher.on('error', (err) => {
      console.warn('[pet] kiro 存储监听断了,退回轮询:', err && err.message);
      kiroWatcher = null;
    });
    return true;
  } catch (err) {
    console.warn('[pet] 监听 kiro 存储失败,退回轮询:', err && err.message);
    return false;
  }
}

/* ---------- 双击云糯 = 开一个全新的临时工作目录 ----------
   路径形如 `<base>/<yyyyMMdd>/<序号>`,序号取当天已有目录的最大值 +1。
   双击的语义就是"给我一块新地方干活",所以永远新建、永不复用、也不弹选择框
   —— 想指定目录走一级菜单「新会话 → 选择目录新会话」。 */
const SCRATCH_BASE = process.env.AICP_WORKSPACE || path.join(require('os').homedir(), 'yunnuo');

/** 临时工作目录的根。不创建目录(这个函数会被菜单小字和 /debug 反复调用,不能有副作用)。 */
function scratchBase() {
  return SCRATCH_BASE;
}

/** 某个目录是不是桌宠自己造的临时工作目录 —— 只有这类才允许从界面上删 */
function isScratchDir(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const rel = path.relative(scratchBase(), dir);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 下一个可用的临时目录路径(只算不建) */
function nextScratchDir() {
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const dayDir = path.join(scratchBase(), day);
  let max = 0;
  try {
    for (const name of fs.readdirSync(dayDir)) {
      const m = /^(\d+)$/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
  } catch {
    /* 当天还没开过工 */
  }
  return path.join(dayDir, String(max + 1).padStart(2, '0'));
}

/**
 * 在指定目录起一个会话。
 *
 * 同一个目录已经有在世会话时,**不再开新的**,直接把原来那只叫回来:
 * 否则从「历史会话」里点一个刚收起来的目录,会冒出第二只宠物,
 * 两只指着同一个工程各跑一套上下文,用户根本分不清该看哪只。
 */
async function newSession(cwd) {
  const client = clientPref();

  const live = store.list().find((s) => s.cwd && s.cwd === cwd);
  if (live) {
    openNewSessionChat(live.id);
    notifyHubSessions();
    return { id: live.id, reused: true };
  }

  // kiro / codex / cursor 等:桌宠不自带内核,落一只「等待接入」的宠物。
  // 你的客户端对同一目录开工后经 hook 上报事件,宠物自动接住(旁路协议)。
  if (client !== 'claude') {
    const sid = `ext-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const placeholder = store.apply({
      session_id: sid,
      kind: 'session_start',
      agent: client,
      cwd,
      project: path.basename(cwd),
      title: `等待 ${client} 接入 · ${path.basename(cwd)}`,
    });
    // 显式标记「等着被真实客户端认领」——store._resolveId 只认这个标记,
    // 不靠 ext- 前缀猜(自动扫描出来的也是 ext- 开头)
    if (placeholder) placeholder.awaitingAdopt = true;
    saveRecent(cwd);
    refreshTray();
    openNewSessionChat(sid); // 直接弹出对话框(等待接入引导)
    return { id: sid };
  }

  try {
    const s = await agents.spawn({ cwd, model: process.env.AICP_MODEL });
    // 先落一条 session 记录，宠物立刻出现，不用等 SDK 的 init 回来
    store.apply({
      session_id: s.id,
      kind: 'session_start',
      agent: 'claude-code',
      cwd,
      project: path.basename(cwd),
    });
    saveRecent(cwd);
    refreshTray();
    openNewSessionChat(s.id); // 直接弹出对话框,进去就能吩咐
    return s;
  } catch (err) {
    console.error('[pet] 开会话失败:', err && err.message);
    dialog.showErrorBox(
      '开会话失败',
      `${err && err.message}\n\n` +
        '桌宠通过 Claude Agent SDK 驱动会话，需要本机已完成 Claude Code 登录，' +
        '或设置了 ANTHROPIC_API_KEY。'
    );
    return null;
  }
}

/**
 * 结束会话 —— 跟「收进宝盒」是两件事:
 *   收进宝盒 = 只藏窗口,会话继续跑,随时从「历史会话」叫回来
 *   结束会话 = 会话真的没了,宠物窗口销毁,「历史会话」里只剩那个目录
 * 有内核的(claude)连 agent 进程一起关;旁路会话(ext-)只去掉桌宠这边的记录。
 * 宠物面板的红 × 和宝盒「历史会话」行尾的 × 都走这里,只有一份实现。
 */
async function endSession(sessionId) {
  if (!store.get(sessionId)) return false;
  try {
    await agents.close(sessionId);
  } catch (err) {
    console.warn('[pet] 关 agent 失败:', err && err.message);
  }
  store.remove(sessionId); // 会带出 windows.destroy + refreshTray + notifyHubSessions
  return true;
}

function ensurePetWindow(sessionId) {
  dockedIds.delete(sessionId); // 放回桌面了,不再算在宝盒里
  let win = windows.get(sessionId);
  if (!win || win.isDestroyed()) {
    win = windows.create(sessionId);
    pushState(sessionId);
    const agent = agents.get(sessionId);
    const tail = agent && agent.tail && agent.tail.length ? agent.tail : passive.tailOf(sessionId);
    if (tail.length) windows.send(sessionId, 'pet:transcript', tail);
  } else {
    windows.reclaimSlot(sessionId); // 被回收过的:重新占最左空位
    if (!win.isVisible()) win.showInactive();
  }
  return win;
}

/**
 * 新会话建成:宠物立好并弹出对话框。
 * 默认给小气泡(card)——不用一上来就顶一个大面板占屏幕，
 * 想细聊再点气泡上的展开箭头(▴)放大成完整会话面板(chat)。
 */
function openNewSessionChat(sessionId) {
  const win = ensurePetWindow(sessionId);
  if (win) {
    store.setExpanded(sessionId, 'card');
    windows.focus(sessionId);
  }
}

async function pickFolderAndStart() {
  const r = await dialog.showOpenDialog({
    title: '选择要开工的目录',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths.length) return false;
  return Boolean(await newSession(r.filePaths[0]));
}

/**
 * 载入皮肤。三种形态的资产解析方式不同：
 *   layered —— SVG 必须内联进 DOM，否则拿不到图层做逐部件插值
 *   frames  —— 整图只需要给出 file:// URL，交给 <img> 交叉淡入
 *   model3d —— 模型文件同样给 URL，由渲染器自己拉
 */
function loadSkin(id) {
  const dir = path.join(__dirname, '..', 'skins', id);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8'));
  const kind = manifest.kind || 'layered';

  const out = { ...manifest, id, kind, dir };

  if (kind === 'layered') {
    const layers = {};
    for (const [name, file] of Object.entries(manifest.layers || {})) {
      layers[name] = fs.readFileSync(path.join(dir, file), 'utf8');
    }
    out.layers = layers;
  }

  if (kind === 'frames') {
    const assets = {};
    for (const [state, file] of Object.entries(manifest.assets || {})) {
      const abs = path.join(dir, file);
      if (!fs.existsSync(abs)) {
        console.warn(`[pet] 皮肤 ${id} 的状态 ${state} 缺资产: ${file}`);
        continue;
      }
      assets[state] = fileUrl(abs);
    }
    out.assets = assets;
  }

  if (kind === 'model3d' && manifest.model && manifest.model.file) {
    out.model = { ...manifest.model, url: fileUrl(path.join(dir, manifest.model.file)) };
  }

  return out;
}

function fileUrl(abs) {
  return `file://${abs.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function buildTray() {
  // 空图 + 文字标题：macOS 菜单栏够用，且不需要任何图片资源
  tray = new Tray(nativeImage.createEmpty());
  refreshTray();
  tray.setToolTip('AI Coding Pet');
}

/**
 * 录制演示用的干净背景（仅 pitch 模式）。铺满左下角一大块,盖住工作环境。
 * 层级同为 screen-saver,但先创建、不 moveTop,宠物展开时会盖到它上面。
 * 整窗点穿,不拦鼠标。
 */
let demoBackdropWin = null;
function openDemoBackdrop(wa) {
  const { BrowserWindow } = require('electron');
  // 覆盖左下角:够放三只宠物一字排开 + 会话面板往上长的高度
  const W = Math.min(760, wa.width);
  const H = Math.min(620, wa.height);
  demoBackdropWin = new BrowserWindow({
    x: wa.x,
    y: wa.y + wa.height - H,
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#fdfbf4',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  demoBackdropWin.setAlwaysOnTop(true, 'screen-saver');
  demoBackdropWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  demoBackdropWin.setIgnoreMouseEvents(true, { forward: true });
  demoBackdropWin.loadURL(`file://${path.join(__dirname, '..', 'renderer', 'demo-backdrop.html')}`);
  demoBackdropWin.once('ready-to-show', () => demoBackdropWin.showInactive());
}

/**
 * 开张宝盒:桌面左下角那朵「云」。
 * 点它 → 选目录开新活 → 新云糯从一朵云里冒出来。
 * 注册进 windows.wins 是为了让 /debug?shot=1 能一起抓它。
 */
function openHub() {
  const { BrowserWindow } = require('electron');
  // 上次拖到哪就停在哪;没有记忆时默认左下角。落位一律过 clampHubAnchor,
  // 保证云糯本体整块在可视区内(旧版没有约束,拖一下就能把它甩到屏幕外找不回来)
  const saved = loadPrefs().hubPos;
  hubAnchor = clampHubAnchor(
    Number.isFinite(saved && saved.x) ? saved.x : null,
    Number.isFinite(saved && saved.y) ? saved.y + HUB_BOX.height : null
  );
  const bounds = hubBounds();

  // 宠物从宝盒右侧派生(底边对齐云糯脚下那条线);宝盒没了退回右下角
  windows.setAnchor(() => {
    if (!hubWin || hubWin.isDestroyed()) return null;
    return { x: hubAnchor.x, bottomY: hubAnchor.bottomY };
  });

  hubWin = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'hub-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  hubWin.setAlwaysOnTop(true, 'screen-saver');
  hubWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认整窗点穿,只有指针压到云糯/菜单时才临时收回(和宠物窗口同一套做法)
  hubWin.setIgnoreMouseEvents(true, { forward: true });
  hubWin.loadURL(
    `file://${path.join(__dirname, '..', 'renderer', 'hub.html')}?skin=${encodeURIComponent(SKIN_ID)}${DEBUG ? '&demo=1' : ''}`
  );
  // 宝盒渲染层的报错必须有出口:之前 hub.js 抛异常时终端一片安静,菜单少一栏也看不出原因
  hubWin.webContents.on('console-message', (ev) => {
    if (ev.level === 'error' || ev.level === 'warning' || DEBUG) {
      const where = ev.sourceId ? `${String(ev.sourceId).split('/').pop()}:${ev.lineNumber}` : '';
      console.log(`[hub] ${ev.level}: ${ev.message} ${where}`.trim());
    }
  });
  hubWin.once('ready-to-show', () => hubWin.showInactive());
  hubWin.on('closed', () => {
    hubWin = null;
    windows.wins.delete('__hub');
  });
  windows.wins.set('__hub', hubWin);
  return hubWin;
}

function toggleHub() {
  if (!hubWin) openHub();
  if (hubWin.isVisible()) hubWin.hide();
  else hubWin.showInactive();
  refreshTray();
}

function refreshTray() {
  if (!tray) return;
  const list = store.list();
  const waiting = list.filter((s) => s.state === S.AWAITING_GRANT || s.state === S.AWAITING_CHOICE || s.state === S.STALE);
  const running = list.filter((s) => s.state === S.RUNNING);

  tray.setTitle(waiting.length ? `糯 ${waiting.length}` : running.length ? `糯·${running.length}` : '糯');

  const items = list.length
    ? list.map((s) => ({
        label: `${s.project || s.agent} — ${labelOf(s.state)}${s.model ? ` (${s.model})` : ''}`,
        // 从托盘点进去直接开会话面板，这样全程不用碰 agent 自己的界面
        click: () => {
        ensurePetWindow(s.id);
        store.setExpanded(s.id, 'chat');
      },
      }))
    : [{ label: '暂无会话', enabled: false }];

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `AI Coding Pet · ${SKIN_ID}`, enabled: false },
      { type: 'separator' },
      { label: '新会话（选目录）…', accelerator: 'Cmd+N', click: () => pickFolderAndStart() },
      { label: `在当前目录开工（${path.basename(process.cwd())}）`, click: () => newSession(process.cwd()) },
      {
        label: hubWin && hubWin.isVisible() ? '藏起开张宝盒' : '召唤开张宝盒',
        click: () => toggleHub(),
      },
      { type: 'separator' },
      ...items,
      { type: 'separator' },
      {
        // 请奏会拦在 kiro 的工具执行路径上,必须由用户显式打开,不能默认生效
        label: '拦下危险操作等我批（kiro）',
        type: 'checkbox',
        checked: grantGateOn(),
        click: (mi) => {
          savePrefs({ grantGate: Boolean(mi.checked) });
          refreshTray();
        },
      },
      { label: '全部折叠', click: () => store.setExpanded(null) },
      {
        label: '打开手机端配对页',
        enabled: Boolean(bridge && bridge.url),
        click: () => bridge && bridge.url && shell.openExternal(bridge.url),
      },
      { label: '打开数据目录', click: () => shell.openPath(HOME) },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ])
  );
}

/**
 * 位姿检查台：一屏摆开全部状态，皮肤迭代时看这个而不是等 demo 走到那一步。
 * 注册进 windows.wins 是为了让 /debug?shot=1 能一起抓它。
 */
function openPoseSheet() {
  const { BrowserWindow } = require('electron');
  const win = new BrowserWindow({
    width: 1240,
    height: 980,
    show: true,
    title: '位姿检查台',
    backgroundColor: '#eceff4',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL(`file://${path.join(__dirname, '..', 'renderer', 'poses.html')}?session=__poses`);
  win.webContents.on('console-message', (ev) => {
    console.log(`[poses] ${ev.level}: ${ev.message}`);
  });
  // 检查台窗口没有崩溃出口时，排障会看到「窗口已销毁」却不知为何
  win.webContents.on('render-process-gone', (_e, d) => {
    console.error('[poses] 渲染进程退出:', d.reason, d.exitCode);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`[poses] 加载失败 ${code} ${desc}`);
  });
  win.on('closed', () => console.log('[poses] 窗口已关闭'));
  windows.wins.set('__poses', win);
}

/**
 * 排障报告。带 ?shot=1 时把每个窗口的渲染结果抓成 PNG 落到数据目录。
 * 用 webContents.capturePage() 而不是系统截图：它拿的是渲染层自己画出来的位图，
 * 不受 macOS 对高层级窗口的截屏策略影响。
 */
async function debugReport(params) {
  const { screen } = require('electron');
  const wantShot = params && params.get('shot') === '1';

  const displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));

  const wins = [];
  for (const [id, win] of windows.wins) {
    if (win.isDestroyed()) {
      wins.push({ id, destroyed: true });
      continue;
    }
    const info = {
      id,
      bounds: win.getBounds(),
      visible: win.isVisible(),
      minimized: win.isMinimized(),
      opacity: win.getOpacity(),
      alwaysOnTop: win.isAlwaysOnTop(),
      url: win.webContents.getURL().split('/').pop(),
      loading: win.webContents.isLoading(),
    };
    if (wantShot) {
      try {
        const img = await win.webContents.capturePage();
        const file = path.join(HOME, `shot-${id}.png`);
        fs.writeFileSync(file, img.toPNG());
        info.shot = file;
        info.shotSize = img.getSize();
        info.shotEmpty = img.isEmpty();
      } catch (err) {
        info.shotError = String(err && err.message);
      }
    }
    wins.push(info);
  }

  return {
    displays,
    windows: wins,
    expandedId: store.expandedId,
    // 双击云糯(快速新会话)当前会落在哪个目录 —— 排查"双击只能新建一只"这类问题
    kiroScan: {
      ageSec: lastKiroScan.at ? Math.round((Date.now() - lastKiroScan.at) / 1000) : null,
      scans: lastKiroScan.scans,
      watching: Boolean(kiroWatcher),
      windows: lastKiroScan.windows.map((w) => ({
        folder: w.folder,
        quietSec: w.quietSec,
        sessions: (w.sessions || []).map((k) => `${k.focused ? '*' : ' '}${k.title || k.id}`),
      })),
    },
    sessions: store.list().map((x) => ({
      id: x.id,
      kiroSessionId: x.kiroSessionId || null,
      kiroFocused: Boolean(x.kiroFocused),
      awaitingAdopt: Boolean(x.awaitingAdopt),
      state: x.state,
    })),
    quickNewTarget: nextScratchDir(),
    scratchBase: scratchBase(),
    liveDirs: store.list().map((s) => s.cwd).filter(Boolean),
  };
}

function labelOf(state) {
  return (
    {
      [S.IDLE]: '待命',
      [S.RUNNING]: '运行中',
      [S.AWAITING_GRANT]: '请奏',
      [S.AWAITING_CHOICE]: '请择',
      [S.DONE]: '复奏',
      [S.STALE]: '久候',
      [S.EXITING]: '请退',
      [S.LIMP]: '瘫',
    }[state] || state
  );
}
