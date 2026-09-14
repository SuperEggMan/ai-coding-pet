'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

/**
 * 每 session 一个独立透明窗口（文档结论 2）。
 *
 * 布局约定：
 * - 底排永远只按「宠物本体」的宽度累加摆放(ROW_FOOTPRINT 三档都等于
 *   COLLAPSED.width)：气泡不管哪一档都是从宠物头顶正上方长出来的,
 *   展开气泡不该把后面的队友挤走(挤了很怪:明明没挡着它,详见
 *   ROW_FOOTPRINT 上的注释)。
 * - 但气泡窗口本身(card/chat)比宠物本体宽得多,矩形因此会盖住队友的
 *   窗口矩形——这块是靠"点穿透明区域"解决的:两只窗口的矩形**允许重叠**，
 *   靠命中测试(pet.js 的 isOverSolid + setInteractive)精确判断鼠标压在
 *   哪一只的实体像素上，点哪只都精确命中那一只，不靠矩形互斥。
 * - 展开时先把窗口 bounds 放大再让 CSS 在里面长，避免动画被窗口边界裁掉；
 *   收起时反过来，等 CSS 收完再缩窗口 —— 后面因此要跟着左移的宠物，
 *   也等这个收起动画播完才挪，不然会看见它们提前扎堆再突然弹开。
 */

/* 宠物=小孩个头,明显小于宝盒里的云糯(132),一眼分得出谁是宝盒谁是宠物。
   必须 = pet.css 的 `--stage` + `.root.collapsed .stage` 那圈 ±8 负边距 */
const COLLAPSED = { width: 100, height: 100 };
// 气泡从宠物头顶正上方长出来,窗口宽度只要够装气泡,高度=气泡+间距+宠物。
// 宽扁优先:横着放得下就少占竖向高度(气泡越宽,同样内容折行越少、越矮)。
// 这些数字必须留得下 pet.css 的 `--card-w` + `.root{padding:8}` + gap 8 + `--stage`。
const EXPANDED = { width: 480, height: 380 };
// 会话面板：桌宠当主界面时真正干活的那一档，要装得下消息流；
// 同样宽扁优先(pet.css 的 `.chat` 是 580x400),输入框浮在宠物右边也算在宽度里。
const CHAT = { width: 620, height: 524 };

const VIEW_SIZE = { collapsed: COLLAPSED, card: EXPANDED, chat: CHAT };

/**
 * 一只宠物在「底部那一排」实际占多宽 —— 决定后面的队友从哪儿站起。
 * 注意这跟窗口宽度(VIEW_SIZE)是两件事:三档气泡都是从宠物头顶「正上方」
 * 长出来的,底排永远只有宠物本体,所以展开气泡(不管 card 还是 chat)
 * 都不该把后面的队友往右挤——高度不够就往上长(_rowBounds 的
 * `bottom - size.height` 已经是这么算的),横向没有理由推人。
 * 窗口会变宽变高并盖住队友的窗口矩形,但那块是透明的,靠命中测试点穿
 * (isOverSolid,pet.js)就能精确落到底下那只身上,chat 也走这一套
 * (renderer 的 mousemove 命中测试涵盖 .chat / .composer,详见 pet.js)。
 */
const ROW_FOOTPRINT = {
  collapsed: COLLAPSED.width,
  card: COLLAPSED.width,
  chat: COLLAPSED.width,
};
const COLLAPSE_ANIM_MS = 260; // 与 renderer 的收起动画时长保持一致
const PET_GAP = 14; // 宠物间横向间距
/* 第一只宠物离宝盒锚点多远 —— 只让开云糯本体(hub.css: `.hub{left:8px}` + `.box{132}`)
   再留一点空隙,让宠物紧挨着宝盒站,像跟在主人边上。

   曾经为了"别跟宝盒菜单叠在一起"把这个值推到 244,结果宠物被推得老远。
   重新算过几何:菜单在云糯**头顶**(离屏幕底 152px 起),宠物本体只占底部 100px,
   两者压根不重叠;真正会撞的是宠物**展开的气泡**(也朝上长)。
   所以让位这件事交给「开菜单时先把气泡收起来」(见 main.js 的 hub:menu),
   这里保持贴近。 */
const HUB_ROW_START = 158;

class WindowManager {
  constructor({ debug = false } = {}) {
    this.debug = debug;
    /** sessionId -> BrowserWindow */
    this.wins = new Map();
    /** sessionId -> slot index(排序键,不直接乘步长算像素了) */
    this.slots = new Map();
    /** sessionId -> 'collapsed'|'card'|'chat'，排位公式要知道每只当前占多宽 */
    this.views = new Map();
    this._shrinkTimers = new Map();
    /** 由 main 注入:返回宝盒锚点 {x, bottomY},null = 无宝盒 */
    this._anchor = null;
  }

  /** main 在宝盒创建/销毁时注入锚点提供者 */
  setAnchor(provider) {
    this._anchor = provider;
  }

  has(id) {
    return this.wins.has(id);
  }

  get(id) {
    return this.wins.get(id);
  }

  all() {
    return [...this.wins.values()].filter((w) => !w.isDestroyed());
  }

  create(sessionId) {
    if (this.wins.has(sessionId)) return this.wins.get(sessionId);

    this._takeSlot(sessionId);
    this.views.set(sessionId, 'collapsed');
    const bounds = this._rowBounds().get(sessionId) || { x: 0, y: 0, ...COLLAPSED };

    const win = new BrowserWindow({
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
      // 透明窗口在 macOS 上必须关掉背景材质，否则边缘会出现灰底
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // 「跨界面最高层锁定」：screen-saver 层 + 跟随所有桌面 + 全屏应用之上
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 默认整窗点穿,指针压到宠物实体上时 renderer 报告一声再临时收回
    // (跟宝盒同一套做法)。这条是必需的,不是优化:
    // 展开的气泡窗口会盖住后面队友的窗口矩形,只有点穿才能让点击精确落到
    // 底下那只身上;顺带也不会挡住桌面图标。
    //
    // 历史备注:曾经因为"点宠物没反应"怀疑到 forward 转发不可靠,改成常驻可点。
    // 真正的原因是 pet.css 里 .stage 上的 `-webkit-app-region: drag`
    // 把 mousedown 截去做原生窗口拖拽了(详见 docs/handoff-click-issue.md),
    // 跟点穿无关,所以这里恢复。
    win.setIgnoreMouseEvents(true, { forward: true });

    const url = `file://${path.join(__dirname, '..', 'renderer', 'pet.html')}?session=${encodeURIComponent(sessionId)}`;
    win.loadURL(url);

    win.once('ready-to-show', () => {
      win.showInactive(); // 不抢焦点
    });

    // 渲染层的错误必须有出口，否则窗口一片空白也看不出原因
    win.webContents.on('console-message', (ev) => {
      const level = ev.level; // 'error' | 'warning' | 'info' | 'debug'
      if (level === 'error' || level === 'warning' || this.debug) {
        const where = ev.sourceId ? `${String(ev.sourceId).split('/').pop()}:${ev.lineNumber}` : '';
        console.log(`[renderer ${sessionId}] ${level}: ${ev.message} ${where}`.trim());
      }
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[renderer ${sessionId}] 加载失败 ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[renderer ${sessionId}] 渲染进程退出:`, details.reason);
    });

    win.on('closed', () => {
      this.wins.delete(sessionId);
      this.slots.delete(sessionId);
      this.views.delete(sessionId);
    });

    if (this.debug && process.env.AICP_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

    this.wins.set(sessionId, win);
    return win;
  }

  destroy(sessionId) {
    const win = this.wins.get(sessionId);
    const t = this._shrinkTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      this._shrinkTimers.delete(sessionId);
    }
    if (win && !win.isDestroyed()) win.close();
    this.wins.delete(sessionId);
    this.slots.delete(sessionId);
    this.views.delete(sessionId);
    this._layoutAll(); // 少了一只,后面的贴拢过来,别留空洞
  }

  destroyAll() {
    for (const id of [...this.wins.keys()]) this.destroy(id);
  }

  /**
   * 切换档位时调整窗口尺寸,并让全排队友按新宽度重新落位。
   * @param {'collapsed'|'card'|'chat'} view
   */
  setView(sessionId, view) {
    const win = this.wins.get(sessionId);
    if (!win || win.isDestroyed()) return;
    this.views.set(sessionId, view);
    this._layoutAll();
  }

  /**
   * 把整排宠物按当前各自的档位重新算一遍位置并落位。
   * 单只窗口自己变大、或因为前面的队友变大而要让位靠右:立即生效
   * (不然点击会先落在还没挪开的旧位置上)。
   * 变小、或因为前面的队友变小而要跟着靠左收拢:等 CSS 收起动画播完再挪，
   * 不然会看见还没消失的气泡突然被别的宠物窗口顶过去。
   */
  _layoutAll() {
    const bounds = this._rowBounds();
    for (const [id, win] of this.wins) {
      if (win.isDestroyed()) continue;
      const next = bounds.get(id);
      if (!next) continue; // 宝盒等不在排队里的窗口

      const pending = this._shrinkTimers.get(id);
      if (pending) {
        clearTimeout(pending);
        this._shrinkTimers.delete(id);
      }

      const cur = win.getBounds();
      const unchanged = next.x === cur.x && next.y === cur.y && next.width === cur.width && next.height === cur.height;
      if (unchanged) continue;

      const expandsOrShiftsRight = next.width > cur.width || next.height > cur.height || next.x > cur.x;
      if (expandsOrShiftsRight) {
        win.setBounds(next, false);
        if (next.width > cur.width || next.height > cur.height) win.moveTop();
        continue;
      }

      const t = setTimeout(() => {
        this._shrinkTimers.delete(id);
        if (!win.isDestroyed()) {
          const latest = this._rowBounds().get(id); // 延时期间队形可能又变了,重算一次
          if (latest) win.setBounds(latest, false);
        }
      }, COLLAPSE_ANIM_MS);
      if (t.unref) t.unref();
      this._shrinkTimers.set(id, t);
    }
  }

  /**
   * 聚焦会话面板，让输入框能真的收到键盘。
   * 只拿 OS 级窗口焦点(键盘),不动鼠标穿透——鼠标是否接管仍然靠 renderer 的
   * 命中测试(跟 card 同一套,见 pet.js 的 isOverSolid),不然整窗常驻可点
   * 会把跟队友重叠的透明区域也一起吃成实体,点击落不到底下那只身上。
   */
  focus(sessionId) {
    const win = this.wins.get(sessionId);
    if (!win || win.isDestroyed()) return;
    win.focus();
  }

  /** renderer 报告指针是否压在宠物实体上，据此开关整窗穿透。 */
  setInteractive(sessionId, interactive) {
    const win = this.wins.get(sessionId);
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  }

  send(sessionId, channel, payload) {
    const win = this.wins.get(sessionId);
    if (!win || win.isDestroyed()) return;
    win.webContents.send(channel, payload);
  }

  broadcast(channel, payload) {
    for (const win of this.all()) win.webContents.send(channel, payload);
  }

  _takeSlot(sessionId) {
    const used = new Set(this.slots.values());
    let i = 0;
    while (used.has(i)) i += 1;
    this.slots.set(sessionId, i);
    return i;
  }

  /** 回收进宝盒时释放排位,新会话/叫回的宠物从最左空位排 */
  freeSlot(sessionId) {
    this.slots.delete(sessionId);
    this._layoutAll(); // 让出来的空当,后面的贴拢
  }

  /** 把已存在的(可能被回收过的)窗口重新排入最左空位,马上要 show 出来,不等收起动画 */
  reclaimSlot(sessionId) {
    if (!this.slots.has(sessionId)) {
      this._takeSlot(sessionId);
      this.views.set(sessionId, 'collapsed');
    }
    this._layoutAll();
    const pending = this._shrinkTimers.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this._shrinkTimers.delete(sessionId);
    }
    const win = this.wins.get(sessionId);
    const b = this._rowBounds().get(sessionId);
    if (win && !win.isDestroyed() && b) win.setBounds(b, false);
    return this.slots.get(sessionId);
  }

  /**
   * 按 slot 顺序把每只宠物累加排开:每只的 x = 前面所有队友「本体宽度」
   * (ROW_FOOTPRINT,三档都等于 COLLAPSED.width)之和——气泡展开不占这个宽度,
   * 所以气泡窗口矩形可能跟队友重叠,靠 renderer 的命中测试点穿来分辨点哪只。
   * 宝盒模式从宝盒右侧向右排;没宝盒时退回屏幕右下角向左排。
   */
  _rowBounds() {
    const display = screen.getPrimaryDisplay();
    const wa = display.workArea;
    const a = this._anchor ? this._anchor() : null;
    const entries = [...this.slots.entries()].sort((x, y) => x[1] - y[1]);
    const out = new Map();

    if (a) {
      let x = a.x + HUB_ROW_START;
      const bottom = a.bottomY;
      for (const [id] of entries) {
        const view = this.views.get(id) || 'collapsed';
        const size = VIEW_SIZE[view] || COLLAPSED;
        const y = Math.max(wa.y + 4, bottom - size.height);
        out.set(id, { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height });
        x += (ROW_FOOTPRINT[view] || COLLAPSED.width) + PET_GAP;
      }
    } else {
      let right = wa.x + wa.width - 16;
      const bottom = wa.y + wa.height - 16;
      for (const [id] of entries) {
        const view = this.views.get(id) || 'collapsed';
        const size = VIEW_SIZE[view] || COLLAPSED;
        const foot = ROW_FOOTPRINT[view] || COLLAPSED.width;
        // 从右往左排时,宠物本体贴着 footprint 的左缘站(窗口自己往右溢出)
        const x = right - foot;
        const y = Math.max(wa.y + 4, bottom - size.height);
        out.set(id, { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height });
        right = x - PET_GAP;
      }
    }
    return out;
  }
}

module.exports = { WindowManager, COLLAPSED, EXPANDED, CHAT, VIEW_SIZE, COLLAPSE_ANIM_MS, HUB_ROW_START };
