'use strict';

const { EventEmitter } = require('events');
const { S, TIER, classifyGrant, priorityOf, needsHuman } = require('./states');

/**
 * 超时阈值。
 *
 * 这些值决定「奏折」如何逐级升调，是产品手感的核心，所以集中在一处，
 * 后面按真实使用体感调，不要散落到各个分支里。
 */
const TIMING = {
  /** 等授权 / 等选择 无人理 → stale（催一次） */
  STALE_MS: 90 * 1000,
  /** done 无人查看 → exiting（请奏退出） */
  ACK_MS: 45 * 1000,
  /** exiting 仍无人理 → limp（瘫） */
  LIMP_MS: 60 * 1000,
  /** running 静默多久算掉线（进程已退时才用） */
  SILENT_MS: 5 * 60 * 1000,
  /** limp 之后多久自动回收窗口 */
  REAP_MS: 10 * 60 * 1000,
};

let seq = 0;

class SessionStore extends EventEmitter {
  constructor(timing = {}) {
    super();
    this.timing = { ...TIMING, ...timing };
    /** @type {Map<string, object>} */
    this.sessions = new Map();
    /**
     * 这只会话能不能在桌宠里直接指挥(由 main 注入,判据是有没有 agent 内核)。
     * 放在 store 而不是各自计算,是为了渲染层和手机端看到的是同一个口径。
     */
    this._commandable = () => false;
    /** 旁路客户端自己生成的 id -> 桌宠这边的 session id(见 _resolveId) */
    this.aliases = new Map();
    /** 当前唯一展开的 session id */
    this.expandedId = null;
    /** 展开档位：'card' | 'chat' | null */
    this.expandedView = null;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick(), 1000);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /** main 注入:给定 session id,桌宠这边有没有内核可以接指令 */
  setCommandable(fn) {
    if (typeof fn === 'function') this._commandable = fn;
  }

  get(id) {
    return this.sessions.get(id);
  }

  list() {
    return [...this.sessions.values()].sort((a, b) => {
      const d = priorityOf(b.state) - priorityOf(a.state);
      return d !== 0 ? d : a.createdAt - b.createdAt;
    });
  }

  ensure(id, seed = {}) {
    let s = this.sessions.get(id);
    if (s) {
      // 客户端给了会话标识就记下来:自动扫描据此认出"这只已经有了",
      // 不然 hook 先到、扫描后到时同一个 kiro 会话会分裂成两只宠物(踩过)
      if (seed.kiro_session_id && !s.kiroSessionId) s.kiroSessionId = seed.kiro_session_id;
      // 后来的事件可以补齐先前缺的元信息，但不覆盖已有值
      for (const k of ['agent', 'project', 'model', 'title', 'cwd']) {
        if (seed[k] && !s[k]) s[k] = seed[k];
      }
      return s;
    }
    const now = Date.now();
    s = {
      id,
      ord: ++seq,
      agent: seed.agent || 'unknown',
      project: seed.project || '',
      cwd: seed.cwd || '',
      title: seed.title || '',
      model: seed.model || '',
      state: S.IDLE,
      prevState: null,
      tier: null, // 仅 awaiting_grant 有值
      tierReason: null,
      pending: null, // 阻塞中的审批 / 选择
      liveLine: '', // agent 最近说的一句话
      actions: 0,
      turnStartedAt: null,
      createdAt: now,
      stateSince: now,
      lastEventAt: now,
      exited: false,
      collapsed: true, // 文档结论 1：默认折叠
      view: 'collapsed', // collapsed | card | chat
      // 外部客户端的会话标识(kiro 的 sess_...)。有值 = 这只会话不归桌宠所有
      kiroSessionId: seed.kiro_session_id || '',
    };
    this.sessions.set(id, s);
    this.emit('add', s);
    return s;
  }

  /** 状态迁移的唯一入口，保证 prevState / stateSince 一定被正确记录。 */
  _setState(s, next, patch = {}) {
    const changed = s.state !== next;
    if (changed) {
      s.prevState = s.state;
      s.state = next;
      s.stateSince = Date.now();
      // 离开等授权就把三色清掉，别让旧徽标留在身上
      if (next !== S.AWAITING_GRANT) {
        s.tier = null;
        s.tierReason = null;
      }
    }
    Object.assign(s, patch);
    s.lastEventAt = Date.now();
    this.emit('change', s, { transitioned: changed });
    return changed;
  }

  /**
   * 吃一条已归一化的 hook 事件。
   * @param {{session_id:string, kind:string}} ev
   */
  /**
   * 把上报进来的 session_id 归到某只已有的宠物身上。
   *
   * 旁路客户端(kiro / codex 的 hook)自己生成 id —— 比如 `kiro-<md5(cwd)>` ——
   * 跟宝盒双击造出来的占位会话 `ext-xxxx` 对不上。不认领的话结果是:
   * 占位那只永远显示「等待 kiro 接入」,同时旁边又冒出一只全新的宠物,
   * 同一个工程两只、谁都不对。
   *
   * 判据用 **cwd**:同一个目录上如果有一只还没被认领的 `ext-` 占位宠物,就认它,
   * 并把外部 id 记进 aliases,后续那些不带 cwd 的事件(tool_pre/stop…)也能找回来。
   */
  _resolveId(ev) {
    const raw = ev.session_id;
    const alias = this.aliases.get(raw);
    if (alias && this.sessions.has(alias)) return alias;
    if (this.sessions.has(raw)) return raw;

    const all = [...this.sessions.values()];

    // ⓪ 最准的一条:客户端给了它自己的会话标识(kiro 的 hook payload 里就有
    //    `session_id: "sess_..."`,跟 kiro-scan 从 state.vscdb 读到的
    //    sessionPanels id 是同一个)。能对上就直接落到那只身上,
    //    一个窗口开多个会话面板也不会打错。
    if (ev.kiro_session_id) {
      const exact = all.find((x) => x.kiroSessionId === ev.kiro_session_id);
      if (exact) {
        this.aliases.set(raw, exact.id);
        exact.adopted = true;
        return exact.id;
      }
    }
    if (!ev.cwd) return raw;

    // ① 宝盒双击造的「等待 xxx 接入」占位宠物:认领它,并把外部 id 记进 aliases,
    //    后续不带 cwd 的事件也能找回来。
    //    判据必须是这个显式标记,不能只看 `ext-` 前缀 —— 自动扫描出来的宠物也是
    //    ext- 开头,拿前缀当判据会把同一目录的第二个会话面板并进第一只里(踩过)。
    const taken = new Set(this.aliases.values());
    const waiting = all.find((x) => x.cwd === ev.cwd && x.awaitingAdopt && !taken.has(x.id));
    if (waiting) {
      this.aliases.set(raw, waiting.id);
      waiting.awaitingAdopt = false;
      waiting.adopted = true;
      // 占位标题(「等待 kiro 接入 · xxx」)让位给真实事件带来的标题
      if (/^等待 /.test(waiting.title || '')) waiting.title = '';
      return waiting.id;
    }

    /*
     * ② 退化路径:**只在客户端没给会话标识时**才按 cwd + 聚焦去猜。
     *
     * 这个守卫是必须的,少了它会串号(踩过):自动扫描给同一个工程的第二个
     * 会话面板建宠物时,apply 被这条猜测劫持、返回**第一只**宠物,
     * 于是 `ext-ks-<A>` 身上被写进了会话 B 的 kiroSessionId,精确路由全打偏,
     * 而且第二个面板根本建不出宠物。
     * 带了标识就说明:要么上面 ⓪ 已精确命中,要么这是全新会话,该新建。
     *
     * 这里故意**不写 aliases**:焦点会变,锁死就永远打在旧的那只身上。
     */
    if (ev.kiro_session_id) return raw;
    const focused = all.find((x) => x.cwd === ev.cwd && x.kiroFocused);
    if (focused) {
      focused.adopted = true;
      return focused.id;
    }
    return raw;
  }

  apply(ev) {
    if (!ev || !ev.session_id) return null;
    const id = this._resolveId(ev);
    const s = this.ensure(id, ev);

    switch (ev.kind) {
      case 'session_start':
        this._setState(s, S.IDLE);
        break;

      case 'prompt': {
        s.turnStartedAt = Date.now();
        s.actions = 0;
        if (ev.text && !s.title) s.title = firstLine(ev.text, 60);
        // title 是「你要它干什么」，liveLine 是「它此刻在干什么」。
        // 这里清空 liveLine，让卡片先落到状态文案，等 agent 真说话再填，
        // 否则两行显示的是同一句 prompt。
        this._setState(s, S.RUNNING, { liveLine: '' });
        break;
      }

      case 'tool_pre':
        s.actions += 1;
        if (!s.turnStartedAt) s.turnStartedAt = Date.now();
        this._setState(s, S.RUNNING, {
          liveLine: ev.text || s.liveLine,
          lastTool: ev.tool || s.lastTool,
        });
        break;

      case 'tool_post':
        this._setState(s, S.RUNNING, { liveLine: ev.text || s.liveLine });
        break;

      case 'say': // agent 说话 / 思考行，只更新文案不改状态
        s.liveLine = firstLine(ev.text || '', 160);
        s.lastEventAt = Date.now();
        this.emit('change', s, { transitioned: false });
        break;

      case 'permission_request': {
        const { tier, reason } = classifyGrant(ev.tool, ev.input);
        this._setState(s, S.AWAITING_GRANT, {
          tier,
          tierReason: reason,
          pending: {
            kind: 'grant',
            requestId: ev.request_id,
            tool: ev.tool,
            input: ev.input,
            summary: ev.summary || describeTool(ev.tool, ev.input),
            tier,
            reason,
            at: Date.now(),
          },
        });
        break;
      }

      case 'question':
        this._setState(s, S.AWAITING_CHOICE, {
          pending: {
            kind: 'choice',
            requestId: ev.request_id,
            question: ev.question || '',
            options: Array.isArray(ev.options) ? ev.options : [],
            at: Date.now(),
          },
        });
        break;

      case 'resolved': // 审批/选择已有结果（我们批的，或你在终端里批的）
        this._setState(s, S.RUNNING, { pending: null });
        break;

      case 'stop':
        this._setState(s, S.DONE, {
          pending: null,
          liveLine: ev.text ? firstLine(ev.text, 160) : s.liveLine,
        });
        break;

      case 'exit_request':
        this._setState(s, S.EXITING, { pending: null });
        break;

      case 'session_end':
        s.exited = true;
        // 进程都退了还没人看过，就直接进请奏退出，让它继续在屏幕上叫
        if (!needsHuman(s.state) && s.state !== S.LIMP) {
          this._setState(s, S.EXITING);
        } else {
          s.lastEventAt = Date.now();
          this.emit('change', s, { transitioned: false });
        }
        break;

      default:
        s.lastEventAt = Date.now();
        this.emit('change', s, { transitioned: false });
    }

    this._arbitrateExpanded(s);
    return s;
  }

  /**
   * 文档结论 1：默认折叠，同时只允许一个展开。
   * 需要人处理的状态可以主动抢占展开位；不需要人的状态不抢。
   */
  _arbitrateExpanded(changedSession) {
    if (!changedSession) return;

    const cur0 = this.expandedId ? this.sessions.get(this.expandedId) : null;
    // 展开的这只已经不需要人了 → 把展开位交给还在等的下一只,
    // 一次批完一串,不用人自己去数还剩谁。
    // 只在状态卡档交接:人正在会话面板里干活时不抢他的屏。
    if (cur0 && this.expandedView === 'card' && !needsHuman(cur0.state)) {
      const next = this.waiting().find((s) => s.id !== cur0.id);
      if (next) {
        this.setExpanded(next.id, 'card');
        return;
      }
    }

    if (!needsHuman(changedSession.state)) return;

    const current = this.expandedId ? this.sessions.get(this.expandedId) : null;

    if (current && current.id === changedSession.id) {
      // 已经展开的就是它：保持当前档位，别把正在会话面板里干活的人踢回状态卡
      return;
    }
    if (!current) {
      this.setExpanded(changedSession.id, 'card');
      return;
    }
    // 更急的奏折可以把展开位抢过来
    if (priorityOf(changedSession.state) > priorityOf(current.state)) {
      this.setExpanded(changedSession.id, 'card');
    }
  }

  /**
   * 展开某一只（传 null 表示全折叠）。互斥由这里统一保证。
   * @param {string|null} id
   * @param {'card'|'chat'} view card=状态卡（看一眼就走） chat=会话面板（在桌宠里干活）
   */
  setExpanded(id, view = 'card') {
    const prev = this.expandedId;
    const prevView = this.expandedView;
    if (prev === id && prevView === view) return;

    this.expandedId = id;
    this.expandedView = id ? view : null;

    for (const s of this.sessions.values()) {
      const collapsed = s.id !== id;
      const nextView = collapsed ? 'collapsed' : view;
      if (s.collapsed !== collapsed || s.view !== nextView) {
        s.collapsed = collapsed;
        s.view = nextView;
        this.emit('change', s, { transitioned: false });
      }
    }
    this.emit('expanded', { id, view: this.expandedView, prev, prevView });
  }

  /**
   * 点宠物时的档位轮转：折叠 → 状态卡 → 会话面板 → 折叠。
   * 三档是为了让「只看一眼」和「在桌宠里干活」不互相打扰。
   */
  cycleExpanded(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (this.expandedId !== id) return this.setExpanded(id, 'card');
    if (this.expandedView === 'card') return this.setExpanded(id, 'chat');
    return this.setExpanded(null);
  }

  /** 人看过了 → 把 done/exiting/limp 收掉。 */
  acknowledge(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.state !== S.DONE && s.state !== S.EXITING && s.state !== S.LIMP) return;
    /*
     * 外部客户端(kiro)的会话不是桌宠的,人在这儿"看过了"只能让宠物回到待命,
     * **不能删记录** —— 那个会话在 kiro 里还活着。删了以后自动扫描下一轮又会
     * 把它建回来,用户看到的就是"点一下宠物它就没了/闪一下又回来",
     * 完全对不上"我只是点了一下"。
     */
    if (s.kiroSessionId) {
      this._setState(s, S.IDLE, { pending: null });
      return;
    }
    this.remove(id);
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    for (const [ext, mapped] of this.aliases) if (mapped === id) this.aliases.delete(ext);
    if (this.expandedId === id) this.setExpanded(null);
    this.emit('remove', s);
  }

  /** 每秒跑一次，负责所有「等太久了」的升级。 */
  tick() {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      const held = now - s.stateSince;

      if ((s.state === S.AWAITING_GRANT || s.state === S.AWAITING_CHOICE) && held > this.timing.STALE_MS) {
        this._setState(s, S.STALE);
        continue;
      }
      if (s.state === S.DONE && held > this.timing.ACK_MS) {
        this._setState(s, S.EXITING);
        continue;
      }
      if (s.state === S.EXITING && held > this.timing.LIMP_MS) {
        this._setState(s, S.LIMP);
        continue;
      }
      if (s.state === S.LIMP && held > this.timing.REAP_MS) {
        this.remove(s.id);
        continue;
      }
      if (
        s.state === S.RUNNING &&
        s.exited &&
        now - s.lastEventAt > this.timing.SILENT_MS
      ) {
        // 进程已退且长时间无事件：说「没响应」，不说「完成」
        this._setState(s, S.EXITING, { liveLine: '进程已退出，未收到收尾信号' });
      }
    }
    this.emit('tick', now);
  }

  /** 还在等人处理的会话(按优先级排好序),第一个就是"下一个该看谁"。 */
  waiting() {
    return this.list().filter((s) => needsHuman(s.state));
  }

  /** 给渲染层 / 手机端的精简快照。 */
  snapshot() {
    const waitingCount = this.waiting().length;
    const list = this.list();
    return list.map((s) => ({
      waitingCount,
      // 桌面上一共几只 —— 折叠态的身份名牌据此决定要不要露脸:
      // 只有一只时压根不存在"分不清哪只是哪只"的问题,挂个名牌只是遮住脚。
      petCount: list.length,
      id: s.id,
      agent: s.agent,
      project: s.project,
      title: s.title,
      model: s.model,
      state: s.state,
      tier: s.tier,
      tierReason: s.tierReason,
      liveLine: s.liveLine,
      actions: s.actions,
      elapsedMs: s.turnStartedAt ? Date.now() - s.turnStartedAt : 0,
      heldMs: Date.now() - s.stateSince,
      collapsed: s.collapsed,
      view: s.view,
      adopted: Boolean(s.adopted), // 旁路会话已经被真实客户端认领
      // 能不能在桌宠里发指令。旁路会话(kiro/codex)只能看:没有内核接得住,
      // 界面上必须据此把输入框、权限模式这些"假的可交互"整块撤掉。
      canCommand: this._commandable(s.id),
      // 由自动扫描认出来的、真实存在于 kiro 里的会话面板。
      // 跟"宝盒双击造的占位宠物"要分开说:那个才是"等待接入",这个已经连上了。
      kiroLinked: Boolean(s.kiroSessionId),
      permissionMode: s.permissionMode || 'default',
      pending: s.pending
        ? {
            kind: s.pending.kind,
            summary: s.pending.summary,
            question: s.pending.question,
            options: s.pending.options,
            tier: s.pending.tier,
            reason: s.pending.reason,
          }
        : null,
      exited: s.exited,
    }));
  }
}

function firstLine(text, max) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/** 没有 summary 时，从工具名+入参凑一句人能看懂的话。 */
function describeTool(tool, input) {
  const t = String(tool || 'tool');
  if (input && typeof input === 'object') {
    const cand = input.command || input.cmd || input.path || input.file_path || input.filePath || input.query;
    if (cand) return `${t}: ${String(cand).slice(0, 120)}`;
  }
  if (typeof input === 'string' && input) return `${t}: ${input.slice(0, 120)}`;
  return t;
}

module.exports = { SessionStore, TIMING, _firstLine: firstLine, _describeTool: describeTool };
