'use strict';

import { createRenderer } from './renderers.js';
import { identLabel } from './ident.mjs';

const $ = (id) => document.getElementById(id);

const el = {
  root: $('root'),
  stage: $('stage'),
  svgHost: $('svgHost'),
  dot: $('collapsedDot'),
  identTag: $('identTag'),

  // 状态卡
  card: $('card'),
  tierBadge: $('tierBadge'),
  project: $('project'),
  agent: $('agent'),
  title: $('title'),
  liveLine: $('liveLine'),
  pendingBox: $('pendingBox'),
  pendingSummary: $('pendingSummary'),
  pendingReason: $('pendingReason'),
  choiceBox: $('choiceBox'),
  stateLabel: $('stateLabel'),
  model: $('model'),
  elapsed: $('elapsed'),
  actions: $('actions'),
  actionBar: $('actionBar'),
  btnToChat: $('btnToChat'),
  btnClose: $('btnClose'),
  dockCard: $('dockCard'),
  dockChat: $('dockChat'),

  // 会话面板
  chat: $('chat'),
  observeBar: $('observeBar'),
  observeText: $('observeText'),
  btnReveal: $('btnReveal'),
  chatTierBadge: $('chatTierBadge'),
  chatProject: $('chatProject'),
  chatState: $('chatState'),
  modeSel: $('modeSel'),
  chatToCard: $('chatToCard'),
  btnEnd: $('btnEnd'),
  stream: $('stream'),
  chatPending: $('chatPending'),
  cpLabel: $('cpLabel'),
  cpReason: $('cpReason'),
  cpSummary: $('cpSummary'),
  cpGrant: $('cpGrant'),
  cpChoice: $('cpChoice'),
  composer: $('composer'),
  input: $('input'),
  btnSend: $('btnSend'),
  btnStop: $('btnStop'),

  queueHint: $('queueHint'),
  dockBtn: $('dockBtn'),
};

let skin = null;
let engine = null;
let last = null;
// paintLean / goHomeThenDock 都要用,声明必须在它们之前
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 流式生成中的气泡：index -> {node, text, kind} */
const liveBlocks = new Map();
let streamHasContent = false;

boot();

async function boot() {
  skin = await window.pet.loadSkin();

  try {
    engine = createRenderer(el.svgHost, skin);
    engine.setState('idle', { immediate: true });
  } catch (err) {
    // 皮肤挂了不能把整个桌宠拖死：交互还得能用
    window.pet.log('皮肤渲染失败:', err.message);
    el.svgHost.textContent = '皮肤加载失败';
    engine = { setState() {}, stop() {} };
  }

  labelVerbs();
  renderStreamEmpty();
  wireInteraction();
  playSpawn();
  startIdleSkits();
  startRunningSegments(); // 皮肤没提供 running_* 片段时直接返回，零开销

  window.pet.onState(render);
  window.pet.onTranscript(appendTranscript);
  window.pet.ready();
}

/** 出生动画:云朵里冒出来,只播一次 */
function playSpawn() {
  el.root.classList.add('spawn');
  el.root.addEventListener('animationend', () => el.root.classList.remove('spawn'), { once: true });
}

/* ============================================================
   待命小动作:让「无事可做」也有活人气
   引擎位姿插值作用在 figure 层,这里把整只宠物(含影子)
   当一层做整体小动作,互不打架。
   以后给皮肤加「真动作帧」(啃胡萝卜之类)时,
   在此处按动作帧交叉淡入即可,调度结构不用改。
   ============================================================ */
const IDLE_GESTURES = ['g-hop', 'g-sway', 'g-stretch', 'g-peek', 'g-droop'];
let idleSkitBusy = false;
let idleSkitTimer = 0;

function startIdleSkits() {
  // 动作池:整体小动作 + (皮肤提供动作帧时)真动作帧,如啃胡萝卜
  const pool = IDLE_GESTURES.map((g) => ({ kind: 'gesture', g }));
  if (skin && skin.assets && skin.assets.idle_chew && engine && typeof engine.playFrame === 'function') {
    pool.push({ kind: 'frame', asset: 'idle_chew' }, { kind: 'frame', asset: 'idle_chew' });
  }

  const run = () => {
    const delay = 5000 + Math.random() * 6000;
    idleSkitTimer = setTimeout(() => {
      if (!idleSkitBusy && last && last.state === 'idle') {
        const action = pool[Math.floor(Math.random() * pool.length)];

        if (action.kind === 'frame') {
          // 真动作帧:啃一会儿,引擎自己会还原到待命帧
          const hold = 2400 + Math.random() * 1200;
          if (engine.playFrame(action.asset, hold)) {
            idleSkitTimer = setTimeout(run, hold + 600);
            return;
          }
          run();
          return;
        }

        idleSkitBusy = true;
        el.stage.classList.add(action.g);
        el.stage.addEventListener(
          'animationend',
          () => {
            el.stage.classList.remove(action.g);
            idleSkitBusy = false;
            run();
          },
          { once: true }
        );
        return;
      }
      run();
    }, delay);
  };
  run();
}

/* ============================================================
   运行中的分段动作

   运行中这个状态动辄持续几分钟，单一个循环重复几百遍会很假。
   所以主力循环之外再准备几段偶发动作（冲刺 / 抹汗 / 踉跄 / 回头瞄你），
   跑一阵随机插一段，播完自己淡回主力。

   复用的是 idle_chew 那套机制：engine.playFrame(资产名, 时长) 临时换图、
   到点自动还原到当前状态的基帧，状态真切走了就放弃还原。调度结构跟
   startIdleSkits 同构，只是触发条件从「待命」换成「运行中」。

   资产靠约定发现：skin.assets 里任何 `running_` 开头的条目都会进池子。
   所以只出了其中两段也能用，一段都没出就整个不启动、零开销。
   ============================================================ */

/** 权重与播放时长的默认值。皮肤可以用 skin.segments 覆盖单条。 */
const RUNNING_SEG_DEFAULTS = {
  // 踉跄最抢戏，权重给低点才显得是偶然
  running_stumble: { weight: 1, ms: 2000 },
  running_burst: { weight: 2, ms: 2200 },
  running_glance: { weight: 2, ms: 2400 },
  running_wipe: { weight: 2, ms: 2600 },
};
/** 跑过这个时长算「跑久了」，抹汗和踉跄的权重翻倍，顺带表达累。 */
const RUNNING_LONG_MS = 120000;
let runSegTimer = 0;

function segConfig(name) {
  // skin.segments[name].ms 由 adopt-anim.py 从 apng 实测写入，优先用它。
  // 硬编码的默认值只是资产还没接进来时的兜底 —— 播放时长必须贴合资产自身时长，
  // 短了会把动作切在中间，长了会把整段又播一遍。
  const fromSkin = ((skin && skin.segments) || {})[name] || {};
  const def = RUNNING_SEG_DEFAULTS[name] || {};
  return {
    weight: fromSkin.weight ?? def.weight ?? 1,
    ms: fromSkin.ms ?? def.ms ?? 2400,
  };
}

function pickSegment(names, elapsedMs) {
  const tired = (elapsedMs || 0) > RUNNING_LONG_MS;
  const bag = [];
  for (const n of names) {
    let w = segConfig(n).weight;
    if (tired && (n === 'running_wipe' || n === 'running_stumble')) w *= 2;
    for (let i = 0; i < w; i += 1) bag.push(n);
  }
  return bag.length ? bag[Math.floor(Math.random() * bag.length)] : '';
}

function startRunningSegments() {
  const assets = (skin && skin.assets) || {};
  const names = Object.keys(assets).filter((k) => /^running_/.test(k) && assets[k]);
  if (!names.length || !engine || typeof engine.playFrame !== 'function') return;

  const run = () => {
    // 主力循环先跑够一阵子，别一进运行中就开始演
    const delay = 8000 + Math.random() * 12000;
    runSegTimer = setTimeout(() => {
      if (!last || last.state !== 'running') {
        run();
        return;
      }
      const seg = pickSegment(names, last.elapsedMs);
      const hold = seg ? segConfig(seg).ms : 0;
      if (seg && engine.playFrame(seg, hold)) {
        // 只在 AICP_DEBUG 下会被主进程打出来。留着是因为「插播到底有没有发生」
        // 从外部几乎测不出来：主力循环本身腿动得快，帧间差异会把插播的跳变淹掉。
        console.log(`[seg] 插播 ${seg} ${hold}ms`);
        runSegTimer = setTimeout(run, hold + 600); // 等它淡回主力再排下一段
        return;
      }
      run();
    }, delay);
  };
  run();
}

/** 按钮文案全部取自皮肤，换皮肤就能整套换说法（言情版 / 宫斗版） */
function labelVerbs() {
  const v = skin.verbs || {};
  const text = { allow: v.allow || '允许', always: v.always || '总是允许', deny: v.deny || '拒绝' };
  // 语义小字挂在 title 上：按钮面保持干净，悬停才解释这键到底做了什么
  const hint = {
    allow: '仅此一次，下次照问',
    always: '此类以后不再问',
    deny: '驳回，让 AI 换条路走',
  };
  for (const bar of [el.actionBar, el.cpGrant]) {
    for (const btn of bar.querySelectorAll('[data-decision]')) {
      const d = btn.dataset.decision;
      btn.textContent = text[d] || d;
      btn.title = hint[d] || '';
    }
  }
}

/* ============================================================
   状态渲染
   ============================================================ */
function render(s) {
  if (!s) return;
  const stateChanged = !last || last.state !== s.state;
  const tierChanged = !last || last.tier !== s.tier;

  const stateDef = skin.states[s.state] || skin.states.idle;
  const accent = resolveAccent(s, stateDef);

  if (stateChanged || tierChanged) {
    el.root.dataset.state = s.state;
    el.root.style.setProperty('--accent', accent);
  }
  // 红档要翻转按钮主次（驳回变主角），蓝/黄档准奏是主角
  el.root.dataset.tier = s.tier || '';

  // 位姿只在状态真的变了才重新过渡，否则每秒的时长刷新会不断打断动画
  if (stateChanged) engine.setState(s.state);

  const view = s.view || (s.collapsed ? 'collapsed' : 'card');
  const viewChanged = !last || (last.view || 'collapsed') !== view;
  el.root.dataset.view = view;
  el.root.classList.toggle('collapsed', view === 'collapsed');
  el.root.dataset.needsHuman = needsHuman(s.state) ? '1' : '0';
  renderIdentTag(s);
  // 只能看的会话:桌宠这边没有内核接指令(旁路的 kiro / codex)。
  // 判据来自主进程(有没有 agent 实例),不在渲染层猜 id 前缀。
  const observeOnly = s.canCommand === false;
  el.root.dataset.observe = observeOnly ? '1' : '0';
  renderObserveBar(observeOnly, s);

  // 旁路会话(ext-):靠客户端 hook 上报。
  // adopted = 已经收到过真实事件,不用再喊"等待接入"了。
  const passive = /^ext-/.test(s.id || '');
  el.root.dataset.passive = passive ? '1' : '0';
  if (passive) renderPassiveIntro(view, s);
  else for (const n of el.root.querySelectorAll('.passive-hint, .passive-note')) n.remove();

  bubbleLifecycle(view, s.state);

  // 进会话面板：把焦点交给输入框，并收掉假指针
  // （chat 档的 mousemove 直接 return，不先收会一直留在面板上）
  if (viewChanged && view === 'chat') {
    el.root.dataset.hot = '0';
    el.root.dataset.press = '0';
    requestAnimationFrame(() => el.input.focus());
  }

  const live = s.liveLine || stateDef.note || '';
  const label = stateDef.label || s.state;

  // --- 状态卡 ---
  el.project.textContent = s.project || s.agent || '未知项目';
  el.agent.textContent = s.agent && s.project ? s.agent : '';
  el.title.textContent = s.title || '';
  el.title.hidden = !s.title || s.title === live;
  el.liveLine.textContent = live;
  el.stateLabel.textContent = label;
  el.model.textContent = s.model || '—';
  el.elapsed.textContent = fmtDuration(s.state === 'running' ? s.elapsedMs : s.heldMs);
  el.actions.textContent = `${s.actions || 0} 动作`;
  // 同时只有一只能展开,把"后面还有谁在等"说出来,不然被抢走展开位的那几只是隐形的
  const others = Math.max(0, (s.waitingCount || 0) - (needsHuman(s.state) ? 1 : 0));
  el.queueHint.hidden = others === 0;
  if (others) el.queueHint.textContent = `· 还有 ${others} 只在等`;

  // --- 会话面板抬头 ---
  el.chatProject.textContent = s.project || s.agent || '未知项目';
  el.chatState.textContent = `${label} · ${fmtDuration(s.state === 'running' ? s.elapsedMs : s.heldMs)}`;
  if (document.activeElement !== el.modeSel && s.permissionMode) {
    el.modeSel.value = s.permissionMode;
  }

  const tierText = s.tier ? (skin.tierLabel || {})[s.tier] : null;
  for (const b of [el.tierBadge, el.chatTierBadge]) {
    b.hidden = !tierText;
    if (tierText) b.textContent = tierText;
  }

  renderPending(s);
  last = s;
}

function renderPending(s) {
  const p = s.pending;
  const verbs = skin.verbs || {};
  syncArmWithPending(s);
  if (p && p.kind === 'grant') {
    // 状态卡
    el.pendingBox.hidden = false;
    el.pendingSummary.textContent = p.summary || '';
    el.pendingReason.hidden = !p.reason;
    if (p.reason) el.pendingReason.textContent = `命中破坏性特征：${p.reason}`;
    el.choiceBox.hidden = true;
    el.actionBar.hidden = false;

    // 会话面板
    el.chatPending.hidden = false;
    el.cpLabel.textContent = (skin.states.awaiting_grant || {}).label || '请奏';
    el.cpReason.hidden = !p.reason;
    if (p.reason) el.cpReason.textContent = p.reason;
    el.cpSummary.hidden = false;
    el.cpSummary.textContent = p.summary || '';
    el.cpGrant.hidden = false;
    el.cpChoice.hidden = true;
    return;
  }

  if (p && p.kind === 'choice') {
    el.pendingBox.hidden = true;
    el.actionBar.hidden = true;
    el.choiceBox.hidden = false;
    fillChoices(el.choiceBox, p.options);

    el.chatPending.hidden = false;
    el.cpLabel.textContent = (skin.states.awaiting_choice || {}).label || '请择';
    el.cpReason.hidden = true;
    el.cpSummary.hidden = false;
    el.cpSummary.textContent = p.question || '';
    el.cpGrant.hidden = true;
    el.cpChoice.hidden = false;
    fillChoices(el.cpChoice, p.options);
    return;
  }

  el.pendingBox.hidden = true;
  el.choiceBox.hidden = true;
  el.actionBar.hidden = true;
  el.chatPending.hidden = true;
}

function fillChoices(host, options) {
  host.textContent = '';
  (options || []).forEach((opt, i) => {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = String(opt);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      window.pet.choose(i);
    });
    host.appendChild(b);
  });
}

/* ============================================================
   只能看的会话:把输入区换成一条说明 + 跳回客户端的按钮
   ============================================================ */
const REVEAL_APPS = { kiro: 'Kiro', cursor: 'Cursor', codex: 'VS Code' };

function renderObserveBar(observeOnly, s) {
  el.observeBar.hidden = !observeOnly;
  if (!observeOnly) return;
  const client = s.agent || '客户端';
  const app = REVEAL_APPS[s.agent];
  el.observeText.textContent =
    s.adopted || s.kiroLinked
      ? `只能看 · 在 ${client} 里继续对话,这边同步状态`
      : `只能看 · 等 ${client} 接入后在那边对话`;
  el.btnReveal.hidden = !app;
  if (app) el.btnReveal.textContent = `去 ${app}`;
}

/* ============================================================
   被动等待接入的会话(ext- 开头,如 kiro/codex 双击开工)
   提示用户如何激活,没 agent 时禁掉输入,别让人空敲
   ============================================================ */
function renderPassiveIntro(view, s) {
  const client = s.agent || '客户端';
  // 已经接上了(收到过事件,或本来就是从 kiro 里扫出来的真实会话):
  // 把"在等接入"的引导撤掉 —— 对一只自动同步出来的宠物喊"等待接入"是错的
  if (s.adopted || s.kiroLinked) {
    for (const n of el.root.querySelectorAll('.passive-note')) n.remove();
    if (view === 'chat' && !streamHasContent && !liveBlocks.size) renderLinkedEmpty(client, s);
    const hint = el.card.querySelector('.passive-hint');
    if (hint) hint.textContent = `已接上 ${client} · 在 ${client} 里继续对话,这里同步显示`;
    return;
  }
  if (view === 'chat') {
    if (!streamHasContent && !liveBlocks.size && !el.stream.querySelector('.passive-note')) {
      // 清掉默认空态文案,换成等待接入的引导
      for (const n of el.stream.querySelectorAll('.stream-empty')) {
        if (!n.classList.contains('passive-note')) n.remove();
      }
      const d = document.createElement('div');
      d.className = 'stream-empty passive-note';
      const b = document.createElement('b');
      b.textContent = `云糯在等 ${client} 接入`;
      const small = document.createElement('span');
      small.textContent = `请在 ${client} 里对同一个目录开工;它跑起来后会自动同步到这只云糯。`;
      d.append(b, small);
      el.stream.appendChild(d);
    }
  } else if (!el.card.querySelector('.passive-hint')) {
    // 气泡(状态卡)态:title 已含「等待 xxx 接入 · 目录」,补一行行动指引
    const hint = document.createElement('p');
    hint.className = 'passive-hint';
    hint.textContent = `在 ${client} 里对同一目录开工 → 自动同步到这里`;
    el.liveLine.after(hint);
  }
}

/**
 * 已连上的旁路会话、但还没有任何动作时的空态。
 *
 * 这里的文案改过一次:早先写的是「阅读流永远是空的」,那句是错的。
 * kiro 的 PostToolUse hook 会带 `tool_response`(工具的真实输出),
 * PreToolUse 带 `tool_input`,所以动作和结果是**读得到的**,
 * 真正缺的只有 assistant 的自然语言旁白 —— 那个 hook 确实没有触发点。
 * 所以这里说"还没有动作",而不是"永远看不到"。
 */
function renderLinkedEmpty(client, s) {
  if (el.stream.querySelector('.linked-note')) return;
  el.stream.textContent = '';
  const d = document.createElement('div');
  d.className = 'stream-empty linked-note';
  const b = document.createElement('b');
  b.textContent = s.title || `${client} 会话`;
  const small = document.createElement('span');
  small.textContent = `它一动手,这里就会显示做了什么、结果是什么。${client} 里的自然语言旁白同步不过来,只能看动作。`;
  d.append(b, small);
  el.stream.appendChild(d);
}

/* ============================================================
   阅读流
   ============================================================ */
function renderStreamEmpty() {
  el.stream.textContent = '';
  const d = document.createElement('div');
  d.className = 'stream-empty';
  d.textContent = '还没有对话。\n在下面直接吩咐，全程不用打开 agent 自己的界面。';
  el.stream.appendChild(d);
  streamHasContent = false;
}

function clearEmpty() {
  if (streamHasContent) return;
  el.stream.textContent = '';
  streamHasContent = true;
}

function appendTranscript(items) {
  if (!items || !items.length) return;
  // 追加前先看是不是贴着底，贴底才自动跟随，否则不要把正在回看的人拽走
  const atBottom = el.stream.scrollHeight - el.stream.scrollTop - el.stream.clientHeight < 40;
  clearEmpty();

  for (const it of items) {
    if (it.partial) upsertLive(it);
    else commitFinal(it);
  }

  if (atBottom) el.stream.scrollTop = el.stream.scrollHeight;
}

/** 流式增量：按 content block 的 index 归并到同一个气泡里。 */
function upsertLive(it) {
  const key = `${it.kind}:${it.index ?? 0}`;
  let block = liveBlocks.get(key);
  if (!block) {
    block = { node: makeMsgNode(it.kind, ''), text: '', kind: it.kind };
    block.node.dataset.live = '1';
    el.stream.appendChild(block.node);
    liveBlocks.set(key, block);
  }
  block.text += it.text;
  block.node.textContent = block.text;
}

/**
 * 完整块落地。
 * 开了 includePartialMessages 后同一段文本会既有增量又有完整块，
 * 这里用完整块作为权威值收尾，避免重复渲染。
 */
function commitFinal(it) {
  if (it.kind === 'assistant' || it.kind === 'thinking') {
    const key = [...liveBlocks.keys()].find((k) => k.startsWith(`${it.kind}:`));
    if (key) {
      const block = liveBlocks.get(key);
      block.node.textContent = it.text;
      delete block.node.dataset.live;
      liveBlocks.delete(key);
      return;
    }
  }
  const node = makeMsgNode(it.kind, it.text);
  if (it.kind === 'tool_result') node.dataset.ok = it.ok === false ? '0' : '1';
  // 危险度三色：红/黄/蓝由主进程判好（states.js 的 classifyGrant），这里只上色。
  // 命中破坏性特征时把理由挂上去，鼠标停住能看清是哪一条踩线了。
  if (it.kind === 'tool' && it.tier) {
    node.dataset.tier = it.tier;
    if (it.tierReason) node.title = `命中破坏性特征：${it.tierReason}`;
  }
  el.stream.appendChild(node);
}

function makeMsgNode(kind, text) {
  const d = document.createElement('div');
  d.className = `msg msg-${kind}`;
  d.textContent = text;
  return d;
}

/* ============================================================
   折叠态身份名牌

   要解决的问题:多只宠物折叠站成一排时,状态点告诉你「要不要管它」,
   但压根看不出「这只是哪个会话」。
   文本怎么算在 ident.mjs 里(那两条规则是量出来的,单独放才能跑单测)。
   ============================================================ */
function renderIdentTag(s) {
  const label = identLabel(s);
  el.identTag.hidden = !label;
  if (label && el.identTag.textContent !== label) el.identTag.textContent = label;
}

/* ============================================================
   工具
   ============================================================ */
function resolveAccent(s, stateDef) {
  if (stateDef.accentFrom === 'tier' && s.tier) {
    const map = skin.tierAccent || {};
    if (map[s.tier]) return map[s.tier];
  }
  return stateDef.accent || '#8f9bb3';
}

function needsHuman(state) {
  return ['awaiting_grant', 'awaiting_choice', 'stale', 'exiting'].includes(state);
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/* ============================================================
   气泡生命周期

   两条规则，把「气泡是宠物的嘴」这件事落实：
   1. 瘫 = 完全瘫着，头上不挂任何气泡 → 自动收起窗口。
   2. 待命 / 运行中这类不等人回复的状态，用户点开看一眼后
      几秒没人碰就自动收掉，不让一块大纸片长期霸在宠物头上。
   ============================================================ */
let dismissArmedKey = '';
let dismissTimer = 0;
let limpCollapsedView = null;

function bubbleLifecycle(view, state) {
  if (state === 'limp' && view !== 'collapsed') {
    if (limpCollapsedView === view) return;
    limpCollapsedView = view;
    clearTimeout(dismissTimer);
    dismissTimer = 0;
    window.pet.setView('collapsed');
    return;
  }
  if (view !== 'collapsed') limpCollapsedView = null;

  const key = `${view}|${state}`;
  // 等人回复或等人点头收掉的状态：气泡常驻。换挡时先把旧的自动收起定时器清掉
  const persist = view === 'card' && (needsHuman(state) || state === 'done' || state === 'exiting');
  if (persist) {
    if (key !== dismissArmedKey) {
      dismissArmedKey = key;
      clearTimeout(dismissTimer);
      dismissTimer = 0;
    }
    return;
  }

  if (key === dismissArmedKey) return;
  dismissArmedKey = key;
  clearTimeout(dismissTimer);
  dismissTimer = 0;
  if (view === 'card') {
    dismissTimer = setTimeout(() => {
      dismissTimer = 0;
      window.pet.setView('collapsed');
    }, 4200);
  }
}

/* ============================================================
   交互
   ============================================================ */
function wireInteraction() {
  // 三档统一靠命中测试把鼠标临时收回来(isOverSolid 认 stage/card/chat/
  // composer 里的实体)，整窗常驻不再对任何档位开——那样会把跟队友重叠的
  // 透明区域也吃成实体，点击/点穿都会落错到隔壁那只身上。
  // 会话面板要能打字，靠 windows.focus() 直接拿 OS 键盘焦点(跟鼠标穿透
  // 与否无关)+ el.input.focus()，不需要整窗接管鼠标。
  window.addEventListener('mousemove', (e) => {
    if (petDrag && petDrag.moved) return; // 拖拽中:锁住鼠标,别让点穿把它掐断
    const hot = isOverSolid(e.clientX, e.clientY);
    window.pet.setInteractive(hot);
    el.root.dataset.hot = hot ? '1' : '0';
  });

  window.addEventListener('mouseleave', () => {
    window.pet.setInteractive(false);
    el.root.dataset.hot = '0';
    el.root.dataset.press = '0';
  });

  window.addEventListener('mousedown', () => (el.root.dataset.press = '1'));
  window.addEventListener('mouseup', () => (el.root.dataset.press = '0'));

  // 点宠物：终态的收掉，否则档位轮转(拖过的不算点)
  let petDrag = null;
  const bindDock = (btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      goHomeThenDock();
    });
  bindDock(el.dockBtn);
  bindDock(el.dockCard);
  bindDock(el.dockChat);

  /*
   * 实测发现:原生 click/dblclick 事件在这台机器上不可靠——拖拽(pointerdown/
   * pointermove/pointerup)一直是好的，但按下到松开之间哪怕只有几像素的
   * 轻微位移，click 事件本身就可能被浏览器判成"这是一次拖动"而压根不派发。
   * 所以单击/双击的判定完全不依赖 click/dblclick，改成直接在 pointerup
   * 里用时间窗口自己判——只要 pointerdown→pointerup 之间没超过拖动阈值，
   * 就认定这是一次"点"，两次点之间隔得够近就升级成"双击"。
   */
  let tapTimer = 0;
  let lastTapAt = 0;
  const handleTap = () => {
    clearTimeout(tapTimer);
    if (last && ['done', 'exiting', 'limp'].includes(last.state)) {
      window.pet.acknowledge();
      return;
    }
    window.pet.cycleView();
  };
  const handleTapDouble = () => {
    clearTimeout(tapTimer);
    const cur = el.root.dataset.view;
    if (cur === 'chat') window.pet.setView('collapsed');
    else window.pet.setView('chat');
  };
  const onTapUp = () => {
    const now = Date.now();
    if (now - lastTapAt < 360) {
      lastTapAt = 0;
      handleTapDouble();
      return;
    }
    lastTapAt = now;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(handleTap, 280);
  };

  // 拖动宠物窗口;拖到宝盒的云糯上松开 = 收回宝盒
  //
  // petDrag 必须在 pointerdown 里「同步」建好:单击/双击的判定挂在
  // pointerup 的 `if (!petDrag) return` 后面,一旦先 await 拿窗口坐标再赋值,
  // 快速点一下就会在 IPC 还没回来时先跑完 pointerup —— 那时 petDrag 还是 null,
  // 直接 return,点击永远丢。窗口坐标改成异步补进来(只有真开始拖才需要它)。
  el.stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 舞台上的实体按钮(右下角回收 ×)自己处理点击,这里不能接管:
    // 下面的 setPointerCapture 会把后续 pointerup 和随之派发的 click
    // 全部改派到 el.stage 上,按钮自己的 click 监听一次都收不到
    // —— 表现就是"× 点不动"。
    if (e.target.closest && e.target.closest('button')) return;
    petDrag = { sx: e.screenX, sy: e.screenY, wx: null, wy: null, moved: false, raf: 0, tx: 0, ty: 0 };
    const mine = petDrag;
    window.pet.setInteractive(true); // 拖动全程接管鼠标
    try {
      el.stage.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    window.pet.getPos().then(([wx, wy]) => {
      if (petDrag !== mine) return; // 这一次按下已经结束了,别写回旧状态
      petDrag.wx = wx;
      petDrag.wy = wy;
    });
  });
  const schedulePetDrag = () => {
    if (!petDrag || petDrag.raf) return;
    petDrag.raf = requestAnimationFrame(() => {
      petDrag.raf = 0;
      if (petDrag) window.pet.setPos(petDrag.tx, petDrag.ty);
    });
  };
  el.stage.addEventListener('pointermove', (e) => {
    if (!petDrag) return;
    if (petDrag.wx === null) return; // 窗口坐标还没回来,这一帧先不挪
    if (!petDrag.moved) {
      if (Math.hypot(e.screenX - petDrag.sx, e.screenY - petDrag.sy) < 4) return;
      petDrag.moved = true;
    }
    petDrag.tx = petDrag.wx + (e.screenX - petDrag.sx);
    petDrag.ty = petDrag.wy + (e.screenY - petDrag.sy);
    schedulePetDrag();
  });
  el.stage.addEventListener('pointerup', async (e) => {
    if (!petDrag) return;
    if (petDrag.raf) cancelAnimationFrame(petDrag.raf);
    const wasDrag = petDrag.moved;
    const zone = wasDrag ? await window.pet.getHubZone() : null;
    petDrag = null;
    if (zone && e.screenX >= zone.x && e.screenX <= zone.x + zone.w &&
        e.screenY >= zone.y && e.screenY <= zone.y + zone.h) {
      goHomeThenDock(); // 拖进宝盒 = 回窝
      return;
    }
    if (!wasDrag) onTapUp();
  });
  el.stage.addEventListener('pointercancel', () => (petDrag = null));

  el.btnToChat.addEventListener('click', (e) => {
    e.stopPropagation();
    window.pet.setView('chat');
  });
  el.btnClose.addEventListener('click', (e) => {
    e.stopPropagation();
    window.pet.setView('collapsed');
  });
  el.btnReveal.addEventListener('click', (e) => {
    e.stopPropagation();
    window.pet.reveal();
  });

  el.chatToCard.addEventListener('click', (e) => {
    e.stopPropagation();
    window.pet.setView('card');
  });

  /*
   * 结束会话是唯一不可恢复的动作(「收进宝盒」只是藏窗口),所以两步确认:
   * 第一下变成「再按结束」,3 秒内不按自动还原 —— 跟「永准」同一套手势。
   */
  let endArm = 0;
  const disarmEnd = () => {
    clearTimeout(endArm);
    endArm = 0;
    el.btnEnd.classList.remove('arming');
    el.btnEnd.textContent = '×';
    el.btnEnd.title = '结束会话（不可恢复）';
  };
  el.btnEnd.addEventListener('click', (e) => {
    e.stopPropagation();
    if (endArm) {
      disarmEnd();
      window.pet.endSession();
      return;
    }
    el.btnEnd.classList.add('arming');
    el.btnEnd.textContent = '结束?';
    el.btnEnd.title = '再按一次真的结束;3 秒不按自动还原';
    endArm = setTimeout(disarmEnd, 3000);
  });

  for (const bar of [el.actionBar, el.cpGrant]) {
    for (const btn of bar.querySelectorAll('[data-decision]')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const d = btn.dataset.decision;
        // 永准是「以后同类都不问了」的高权限键,两步确认防手滑:
        // 第一下变「再按确认」,3 秒内第二下才生效,否则自动还原
        if (d === 'always' && !(alwaysArm && alwaysArm.btn === btn)) {
          armAlways(btn);
          return;
        }
        disarmAlwaysArm();
        window.pet.decide(d);
      });
    }
  }

  el.card.addEventListener('click', (e) => e.stopPropagation());
  el.chat.addEventListener('click', (e) => e.stopPropagation());

  // --- 输入 ---
  el.input.addEventListener('input', autoGrow);
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  el.btnSend.addEventListener('click', submit);
  el.btnStop.addEventListener('click', () => window.pet.interrupt());
  el.modeSel.addEventListener('change', () => window.pet.setPermissionMode(el.modeSel.value));
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 108)}px`;
}

/* ============================================================
   回窝睡觉

   「收进宝盒」以前是窗口一声不响地消失,像是被关掉了,跟"它回窝里待着、
   随时能叫回来"这个意思对不上。现在:头上的气泡先收起来 → 宠物打两个呵欠、
   缩成一团 → 窗口一路挪到宝盒里的云糯身上 → 才真的藏起来。
   CSS 只能动窗口里的内容,窗口本体那段平移必须在这里用 rAF 自己走。
   ============================================================ */
const GO_HOME_MS = 480;
let goingHome = false;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function goHomeThenDock() {
  if (goingHome) return;
  goingHome = true;
  try {
    // 头上还挂着气泡/面板时先收起来,不然会看到一大张纸片飞向宝盒
    if (el.root.dataset.view !== 'collapsed') {
      window.pet.setView('collapsed');
      await wait(Number.parseInt(getComputedStyle(el.root).getPropertyValue('--collapse-ms'), 10) || 260);
    }

    if (!reducedMotion) {
      const [zone, pos] = await Promise.all([window.pet.getHubZone(), window.pet.getPos()]);
      for (const g of IDLE_GESTURES) el.stage.classList.remove(g); // 别跟待命小动作抢 transform
      el.stage.classList.add('go-home');
      // 宝盒藏起来时没有窝可回,就地缩成一团
      await travelHome(zone ? homeTarget(zone, pos) : null);
    }

    window.pet.dock();
    // 先藏再复位:顺序反了会看到复原的那一帧闪一下
    await wait(60);
  } finally {
    el.stage.classList.remove('go-home');
    goingHome = false;
  }
}

/** 让宠物本体的中心正好落在窝的中心 → 换算成窗口该挪到哪 */
function homeTarget(zone, [wx, wy]) {
  const r = el.stage.getBoundingClientRect();
  return {
    fx: wx,
    fy: wy,
    tx: Math.round(zone.x + zone.w / 2 - (r.left + r.width / 2)),
    ty: Math.round(zone.y + zone.h / 2 - (r.top + r.height / 2)),
  };
}

function travelHome(t) {
  return new Promise((done) => {
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / GO_HOME_MS);
      if (t) {
        const e = p * p * (3 - 2 * p); // smoothstep:起步慢、中间快、到窝口稳住
        window.pet.setPos(Math.round(t.fx + (t.tx - t.fx) * e), Math.round(t.fy + (t.ty - t.fy) * e));
      }
      if (p < 1) requestAnimationFrame(step);
      else done();
    };
    requestAnimationFrame(step);
  });
}

/* ---- 永准两步确认 ---- */
let alwaysArm = null;
const ALWAYS_ARM_MS = 3000;
let lastPendingKey = '';

function armAlways(btn) {
  disarmAlwaysArm();
  alwaysArm = {
    btn,
    text: btn.textContent,
    title: btn.title || '',
  };
  btn.classList.add('always-arm');
  btn.textContent = '再按确认';
  btn.title = '再按一次 = 永准;3 秒不按自动还原';
  alwaysArm.timer = setTimeout(disarmAlwaysArm, ALWAYS_ARM_MS);
}

function disarmAlwaysArm() {
  if (!alwaysArm) return;
  clearTimeout(alwaysArm.timer);
  const { btn, text, title } = alwaysArm;
  btn.classList.remove('always-arm');
  btn.textContent = text;
  btn.title = title;
  alwaysArm = null;
}

function pendingKey(s) {
  const p = s && s.pending;
  return p ? `${p.kind}|${p.summary || ''}|${p.reason || ''}` : '';
}

function syncArmWithPending(s) {
  const key = pendingKey(s);
  if (key !== lastPendingKey) {
    lastPendingKey = key;
    disarmAlwaysArm(); // 换了一道奏折(或奏折没了),旧确认作废
  }
}

function submit() {
  const text = el.input.value.trim();
  if (!text) return;
  window.pet.send(text);
  el.input.value = '';
  autoGrow();
  el.stream.scrollTop = el.stream.scrollHeight;
}

/**
 * 命中测试：这个点上有没有我们的实体像素。
 * 用 elementFromPoint 而不是算矩形，因为宠物是不规则形状，
 * 拿包围盒当热区会让右下角一大片空白也吃掉鼠标。
 */
function isOverSolid(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return false;
  if (hit === document.documentElement || hit === document.body || hit === el.root) return false;
  if (el.card.contains(hit) && el.root.dataset.view === 'card') return true;
  // chat 档不再整窗接管鼠标(见 wireInteraction 的注释)，靠这里点穿:
  // 面板本体 + 悬浮的输入框都要能收到鼠标，否则打字/点按钮会失灵。
  if (el.root.dataset.view === 'chat' && (el.chat.contains(hit) || el.composer.contains(hit))) return true;
  if (el.dockBtn.contains(hit)) return true;
  if (el.stage.contains(hit)) {
    if (hit === el.stage || hit === el.svgHost) return false;
    const tag = hit.tagName.toLowerCase();
    if (tag === 'svg' || tag === 'g' || tag === 'defs') return false;
    return true;
  }
  return false;
}
