'use strict';

const root = document.getElementById('hub');
const box = document.getElementById('box');
const menu = document.getElementById('menu');

const headClient = document.getElementById('headClient');
const clientChev = document.getElementById('clientChev');
const clientValue = document.getElementById('clientValue');
const clientList = document.getElementById('clientList');

const headNew = document.getElementById('headNew');
const newChev = document.getElementById('newChev');
const subNew = document.getElementById('subNew');
const btnQuick = document.getElementById('btnQuick');
const quickHint = document.getElementById('quickHint');
const btnPickDir = document.getElementById('btnPickDir');

const headHistory = document.getElementById('headHistory');
const hisChev = document.getElementById('hisChev');
const recentCount = document.getElementById('recentCount');
const recentList = document.getElementById('recentList');



const puff = document.getElementById('puff');
const mascot = document.getElementById('mascot');

const CLIENTS = [
  { id: 'kiro', label: 'kiro', note: '默认 · 主代理' },
  { id: 'claude', label: 'claude', note: 'Claude Code（原生内核）' },
  { id: 'codex', label: 'codex', note: 'Codex（接入中）' },
  { id: 'cursor', label: 'cursor', note: 'Cursor（接入中）' },
];

/* 云糯立绘:优先当前皮肤的 idle 帧;分层矢量皮肤退回 zhunzou 的整图 SVG */
const skin = new URLSearchParams(location.search).get('skin') || '';
const candidates = [];
if (skin) candidates.push(`../skins/${encodeURIComponent(skin)}/frames/idle.png`);
candidates.push('../skins/zhunzou/pet.svg');
let imgTry = 0;
function loadMascot() {
  if (imgTry >= candidates.length) return;
  const src = candidates[imgTry++];
  mascot.onerror = () => loadMascot();
  mascot.src = src;
}
loadMascot();

/* 云糯别呆站:随机换小动作 APNG */
const MOTIONS = ['hubgif/breathe.png', 'hubgif/sway.png', 'hubgif/chew.png'];
let motionIdx = -1;
let motionTimer = 0;
mascot.addEventListener('load', () => {
  if (motionTimer) return;
  if (!mascot.src.includes('frames/idle.png')) return;
  motionTimer = setInterval(() => {
    let next;
    do {
      next = Math.floor(Math.random() * MOTIONS.length);
    } while (next === motionIdx && MOTIONS.length > 1);
    motionIdx = next;
    mascot.src = MOTIONS[next];
  }, 6000);
});

/* ---------- 状态与选项 ---------- */
let recentDirs = [];
let scratchBase = '';
let currentClient = 'kiro';
let canCreate = false;
let busy = false;

async function getOptions() {
  try {
    return await window.hub.options();
  } catch {
    return { defaultDir: '', recents: [], client: 'kiro' };
  }
}

async function refreshOptions() {
  const { defaultDir, recents, client, scratchBase: base, canCreate: cc } = await getOptions();
  recentDirs = recents || [];
  scratchBase = base || '';
  canCreate = Boolean(cc);
  // 观测型客户端(kiro/codex/cursor):桌宠开不出会话,「新会话」整块藏掉
  headNew.parentElement.hidden = !canCreate;
  currentClient = client || 'kiro';
  // 小字显示"下一个会建在哪":末两级(日期/序号)够认,完整路径太长会被省略号吃掉
  const seg = (defaultDir || '').split('/').filter(Boolean).slice(-2).join('/');
  quickHint.textContent = defaultDir ? `新建 · ${seg}` : '新建一块工作目录';
  renderClients();
  await renderHistory();
}

/* ---------- 开工客户端 ---------- */
function renderClients() {
  clientList.textContent = '';
  // 把"这个客户端能干到什么程度"直接写在收起状态的小字上,不用点进去猜
  clientValue.textContent = `${currentClient} · ${canCreate ? '可在桌宠里开工' : '只能观测'}`;
  for (const c of CLIENTS) {
    const li = document.createElement('li');
    li.dataset.client = c.id;
    li.innerHTML = `<b></b><small></small>`;
    li.querySelector('b').textContent = c.label;
    li.querySelector('small').textContent = c.note;
    if (c.id === currentClient) li.classList.add('picked');
    li.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (c.id === currentClient) return;
      currentClient = c.id;
      await window.hub.setClient(c.id);
      renderClients();
    });
    clientList.appendChild(li);
  }
}

/* ---------- 历史会话 ----------
   一栏两种行:
   1. 进行中的会话(包括收进宝盒的)—— 点一下把**原来那只**放回桌面,
      会话 id / agent 进程 / 阅读流全都还是原来的。
   2. 开工过但现在没会话的目录 —— 点一下在那儿开会话。
   合成一栏是因为用户视角里它们是同一件事「我以前在哪儿干过活」;
   分成两栏最容易踩的坑是:想找回刚收起来的那只,却从目录那栏又开了一只新的,
   同一个目录冒出两只宠物。现在同目录只会有一只(主进程侧也做了去重兜底)。 */
async function renderHistory() {
  let live = [];
  try {
    live = (await window.hub.sessions()) || [];
  } catch {
    live = [];
  }
  // 收进宝盒的排最前(这一栏最主要就是来找它们的),再是桌面上的,最后是空目录
  live.sort((a, b) => Number(b.docked) - Number(a.docked));

  const liveDirs = new Set(live.map((s) => s.cwd).filter(Boolean));
  const idleDirs = recentDirs.filter((d) => !liveDirs.has(d));

  recentList.textContent = '';
  if (!live.length && !idleDirs.length) {
    recentCount.textContent = '暂无';
    headHistory.disabled = true;
    return;
  }
  headHistory.disabled = false;
  recentCount.textContent = [
    live.length ? `进行中 ${live.length}` : '',
    idleDirs.length ? `未开工 ${idleDirs.length}` : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const row = (title, note, onPick, cls, action) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="txt"><b></b><small></small></span>`;
    li.querySelector('b').textContent = title;
    li.querySelector('small').textContent = note;
    // 调用方会传 'idle-dir inert' 这种多类名的字符串,classList.add 遇到空格会抛
    // InvalidCharacterError,把整个渲染流程打断(实测每次刷新列表都报一次)。拆开加。
    if (cls) li.classList.add(...String(cls).split(/\s+/).filter(Boolean));
    li.addEventListener('click', async (e) => {
      e.stopPropagation();
      await onPick();
    });
    if (action) li.appendChild(action);
    recentList.appendChild(li);
  };

  /*
   * 行尾的收拾键。三种语义各有各的图标和确认文案,别用一个图标糊过去:
   *   在世会话     → ×  结束会话(会话真的没了),两步确认「结束?」
   *   临时工作目录 → 🗑 删掉目录(移废纸篓,可捞回),两步确认「删?」
   *   自己的工程   → ⨯  只从列表划掉,磁盘一个字节不动,不用确认
   */
  const armedBtn = ({ icon, title, armLabel, armTitle, cls, onFire }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `row-act${cls ? ` ${cls}` : ''}`;
    let armed = 0;
    const reset = () => {
      clearTimeout(armed);
      armed = 0;
      btn.classList.remove('armed');
      btn.textContent = icon;
      btn.title = title;
    };
    reset();
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!armLabel) {
        await onFire();
        return;
      }
      if (!armed) {
        btn.classList.add('armed');
        btn.textContent = armLabel;
        btn.title = armTitle;
        armed = setTimeout(reset, 3000);
        return;
      }
      reset();
      await onFire();
    });
    return btn;
  };

  // 在世的会话必须一眼跟"光秃秃的目录"分得开:标题名字往往一模一样
  // (同一个工程),只靠小字区分实测是看不出来的。
  for (const s of live) {
    row(
      `${s.docked ? '☁' : '●'} ${s.project}`,
      s.docked ? `在宝盒里睡着 · ${s.stateLabel} · 点一下放回桌面` : `就在桌面上 · ${s.stateLabel}`,
      async () => {
        await window.hub.recall(s.id);
        toggleMenu(false);
      },
      s.docked ? 'docked' : 'onstage',
      // 收起来的也能直接结掉,不用先叫回桌面再去面板里点
      armedBtn({
        icon: '×',
        title: '结束这个会话（不可恢复）',
        armLabel: '结束?',
        armTitle: '再按一次真的结束;3 秒不按自动还原',
        onFire: async () => {
          await window.hub.endSession(s.id);
          await renderHistory();
        },
      })
    );
  }

  for (const dir of idleDirs) {
    const isScratch = Boolean(scratchBase) && dir.startsWith(`${scratchBase}/`);
    const pick = canCreate ? () => startSession(dir) : async () => {}; // 观测型:目录行只是记录,点不出会话
    // 临时目录名字只有序号(01/02),前面补上日期才认得出是哪一次
    const label = isScratch
      ? dir.slice(scratchBase.length + 1)
      : dir.split('/').filter(Boolean).pop() || dir;
    row(
      label,
      isScratch ? '临时目录 · 未开工' : `未开工 · ${dir}`,
      pick,
      canCreate ? 'idle-dir' : 'idle-dir inert',
      isScratch
        ? armedBtn({
            icon: '🗑',
            title: '删掉这个临时目录（移到废纸篓,可恢复）',
            armLabel: '删?',
            armTitle: '再按一次移到废纸篓;3 秒不按自动还原',
            onFire: async () => {
              await window.hub.trashDir(dir);
              await refreshOptions();
            },
          })
        : armedBtn({
            icon: '⨯',
            title: '从列表移除（不删磁盘）',
            onFire: async () => {
              await window.hub.forgetDir(dir);
              await renderHistory();
            },
          })
    );
  }
}

/* ---------- 开工 ---------- */
/*
 * 双击云糯 / 「快速新会话」:主进程现建一块新地方(<base>/<yyyyMMdd>/<序号>)再开会话。
 * 永远新建,不复用、不弹选择框 —— 想指定目录走「新会话 → 选择目录新会话」。
 */
async function quickNew() {
  // 观测型客户端:桌宠起不了会话,双击不该"没反应"而是"没这功能"。
  // 顺手把菜单弹出来,让人看到「开工客户端」那行小字写着"只能观测"。
  if (!canCreate) {
    toggleMenu(true);
    return;
  }
  if (busy) return;
  busy = true;
  let r = {};
  try {
    r = (await window.hub.quickNew()) || {};
  } finally {
    busy = false; // 少了 finally,一次异常就永久卡死"新建无反应"
  }
  if (r.ok) spawnPuff();
  else await refreshOptions(); // 建目录失败:至少把小字刷新成新的落点
}

async function startSession(dir) {
  if (busy || !dir) return;
  busy = true;
  let r = {};
  try {
    r = (await window.hub.openDir(dir)) || {};
  } finally {
    // 必须 finally:没有它,openDir 一次抛异常 busy 就永久卡在 true,
    // 之后所有「新建」都静默无反应,而且看不出任何原因。
    busy = false;
  }
  if (!r.ok) {
    // 目录已经不在了:重画一遍,那条死目录会从列表里消失(loadRecents 会剔掉它)
    if (r.gone) await refreshOptions();
    return;
  }
  // 「开张」那朵云只在真的新起一只时冒。同一目录已有在世会话时是把原来那只
  // 叫回来(它自己会弹气泡),这里再冒一朵云就是在说谎。
  if (r.reused) toggleMenu(false);
  else spawnPuff();
}

// 有宠物回窝了:只冒云,不动菜单(spawnPuff 那个是开新会话用的,会顺手收菜单)
window.hub.onPuff(() => {
  puff.hidden = true;
  void puff.offsetWidth; // 强制回流,同一元素才能重新播一遍动画
  puff.hidden = false;
  setTimeout(() => {
    puff.hidden = true;
  }, 900);
});

function spawnPuff() {
  puff.hidden = false;
  setTimeout(() => {
    puff.hidden = true;
    toggleMenu(false);
  }, 900);
}

/* ---------- 菜单互斥:一个二级开着,别的自动收 ---------- */
const FLYOUTS = [
  { head: headClient, panel: clientList, chev: clientChev },
  { head: headNew, panel: subNew, chev: newChev },
  { head: headHistory, panel: recentList, chev: hisChev },
];

function setFlyout(target, open) {
  for (const f of FLYOUTS) {
    const show = f === target && open;
    f.panel.hidden = !show;
    f.chev.textContent = show ? '▾' : '▸';
  }
}

for (const f of FLYOUTS) {
  if (f.head === headNew) continue; // 新会话单独绑 单击/双击
  f.head.addEventListener('click', (e) => {
    e.stopPropagation();
    setFlyout(f, f.panel.hidden); // 关着 → 打开并收起其他;开着 → 收
  });
}

// 展开「历史会话」时重新拉一次:菜单开着的这段时间里可能又有宠物被收起来
headHistory.addEventListener('click', () => renderHistory());
// 主进程侧有会话新建/收起/叫回/结束时也重画,菜单开着时计数不会过期
window.hub.onSessionsChanged(() => {
  if (root.dataset.open === '1') renderHistory();
});

/* 「新会话」:单击展开二级,双击直接快速新会话 */
const fNew = FLYOUTS.find((f) => f.head === headNew);
let headNewClick = 0;
headNew.addEventListener('click', (e) => {
  e.stopPropagation();
  clearTimeout(headNewClick);
  headNewClick = setTimeout(() => setFlyout(fNew, fNew.panel.hidden), 220);
});
headNew.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  clearTimeout(headNewClick);
  quickNew();
});

/* 单击 = 弹菜单;双击 = 直接快速新会话;按住拖动 = 挪窗口(绝对坐标,跟手) */
let clickTimer = 0;
let dragState = null;
let suppressClick = false;

/*
 * dragState 必须在 pointerdown 里「同步」建好。
 * 原来先 `await getPos()` 再赋值,快速点一下时 pointerup 会先跑完:
 * 那时 dragState 还是 null,endDrag 直接 return,紧接着 IPC 回来把 dragState
 * 填上 —— 于是留下一个永远不清的幽灵拖拽状态。后果:
 *   ① 之后随便动一下鼠标就 moved=true → 没按住键窗口也跟着跑
 *   ② 下一次 pointerup 把 suppressClick 置 true → 下一次点击被吞掉
 *      (表现就是"双击新建没反应")
 * 窗口坐标改成异步补进来,只有真开始拖才需要它。
 */
box.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  dragState = {
    sx: e.screenX, sy: e.screenY,       // 按下时鼠标屏幕坐标
    winX: null, winY: null,              // 按下时窗口左上角(异步补)
    moved: false,
    raf: 0, wantX: 0, wantY: 0,
  };
  const mine = dragState;
  try {
    box.setPointerCapture(e.pointerId);
  } catch { /* ignore */ }
  window.hub.getPos().then(([winX, winY]) => {
    if (dragState !== mine) return; // 这一次按下已经结束了,别写回旧状态
    dragState.winX = winX;
    dragState.winY = winY;
  });
});

function scheduleDragMove() {
  if (dragState.raf) return;
  dragState.raf = requestAnimationFrame(() => {
    dragState.raf = 0;
    if (!dragState) return;
    window.hub.setPos(dragState.wantX, dragState.wantY);
  });
}

box.addEventListener('pointermove', (e) => {
  if (!dragState) return;
  if (dragState.winX === null) return; // 窗口坐标还没回来,这一帧先不挪
  if (!dragState.moved) {
    if (Math.hypot(e.screenX - dragState.sx, e.screenY - dragState.sy) < 4) return;
    dragState.moved = true;
    clearTimeout(clickTimer);
  }
  // 窗口目标位置 = 按下时窗口位置 + 鼠标从按下列起的位移(绝对坐标,不累计)
  dragState.wantX = dragState.winX + (e.screenX - dragState.sx);
  dragState.wantY = dragState.winY + (e.screenY - dragState.sy);
  scheduleDragMove();
});

function endDrag(e) {
  if (!dragState) return;
  if (dragState.raf) cancelAnimationFrame(dragState.raf);
  if (dragState.moved) suppressClick = true; // 拖过了,这一次按下不算点击
  dragState = null;
}
box.addEventListener('pointerup', endDrag);
box.addEventListener('pointercancel', endDrag);

box.addEventListener('click', (e) => {
  e.stopPropagation();
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => toggleMenu(true), 250);
});
box.addEventListener('dblclick', (e) => {
  e.stopPropagation();
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  clearTimeout(clickTimer);
  quickNew();
});

document.body.addEventListener('click', (e) => {
  if (!menu.contains(e.target)) toggleMenu(false);
});

/*
  宝盒窗口平时只裹住云糯本体(周围不留大片透明实体窗口),菜单要摊开时
  才把窗口临时放大 —— 所以顺序很讲究:
    开:先放大窗口,再显示菜单(否则菜单会被窗口边界裁掉半截)
    关:先隐藏菜单,再缩窗口
  窗口锚在云糯脚下那条线上,缩放过程中云糯的屏幕位置不动。
*/
async function toggleMenu(open) {
  const next = open ? !(root.dataset.open === '1') : false;
  if (next) {
    try {
      await window.hub.menu(true);
    } catch { /* ignore */ }
  }
  root.dataset.open = next ? '1' : '0';
  menu.hidden = !next;
  for (const f of FLYOUTS) {
    f.panel.hidden = true;
    f.chev.textContent = '▸';
  }
  if (next) refreshOptions();
  else window.hub.menu(false).catch(() => {});
}

btnQuick.addEventListener('click', (e) => {
  e.stopPropagation();
  quickNew();
});

/* ---------- 点穿 + 菜单走廊 ----------
   只有实体(云糯/菜单项)收鼠标;云糯与菜单之间留一条透明"走廊",
   指针在走廊里不算离开,菜单不会走到一半就消失。
   ============================================================ */
function isSolidAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return false;
  for (let n = hit; n; n = n.parentElement) {
    if (n === box || n === menu) return true;
    if (n === document.body || n === document.documentElement) return false;
  }
  return false;
}

/* 指针是否还在"云糯 + 菜单 + 走廊"范围内(菜单开着时用) */
function inHubReach(x, y) {
  if (root.dataset.open !== '1') return false;
  const rects = [box.getBoundingClientRect()];
  const m = menu.getBoundingClientRect();
  if (m.width) rects.push(m);
  for (const panel of [clientList, subNew, recentList]) {
    if (!panel.hidden) rects.push(panel.getBoundingClientRect());
  }
  const pad = 10;
  const left = Math.min(...rects.map((r) => r.left)) - pad;
  const right = Math.max(...rects.map((r) => r.right)) + pad;
  const top = Math.min(...rects.map((r) => r.top)) - pad;
  const bottom = Math.max(...rects.map((r) => r.bottom)) + pad;
  return x >= left && x <= right && y >= top && y <= bottom;
}

window.addEventListener('pointermove', (e) => {
  if (dragState && dragState.moved) return; // 拖拽中保持捕获
  if (isSolidAt(e.clientX, e.clientY)) {
    window.hub.setInteractive(true);
    return;
  }
  if (inHubReach(e.clientX, e.clientY)) {
    // 在云糯↔菜单的走廊里:点穿但别收菜单
    window.hub.setInteractive(false);
    return;
  }
  if (root.dataset.open === '1') toggleMenu(false);
  window.hub.setInteractive(false);
});
window.addEventListener('pointerleave', () => {
  if (dragState && dragState.moved) return;
  if (root.dataset.open === '1') toggleMenu(false);
  window.hub.setInteractive(false);
});
btnPickDir.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (busy) return;
  busy = true;
  btnPickDir.disabled = true;
  const ok = await window.hub.pickFolder();
  btnPickDir.disabled = false;
  busy = false;
  if (ok) spawnPuff();
});

/* DEBUG 模式(开张宝盒 ?demo=1)打开即展开全部面板,方便调试排版 */
if (new URLSearchParams(location.search).get('demo') === '1') {
  root.dataset.open = '1';
  menu.hidden = false;
  // 窗口平时只裹住云糯,这里得同步放大,否则菜单被窗口边界裁掉根本看不到
  window.hub.menu(true).catch(() => {});
  refreshOptions().then(() => {
    for (const f of FLYOUTS) {
      f.panel.hidden = false;
      f.chev.textContent = '▾';
    }
  });
}
