'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

const { classifyGrant } = require('./states');

/**
 * Agent 会话内核。
 *
 * 这是「桌宠当主界面」的地基：桌宠不再旁路观察某个 agent 的界面，
 * 而是自己持有一个常驻的 Claude Agent SDK 会话，
 * 读（消息流）、写（发指令）、批（权限）全部发生在桌宠里。
 *
 * 为什么用 Agent SDK 而不是 hook 或 PTY 包壳：
 * - hook 只能收到离散事件，拿不到 assistant 的正文，也无法回灌输入 → 读不了、发不出
 * - PTY 包壳要解析全屏重绘的 ANSI TUI，脆弱且拿不到结构
 * - Agent SDK 的 streaming input 模式是官方为「宿主自己做 UI」设计的：
 *   结构化消息流 + canUseTool 权限回调 + interrupt/setPermissionMode 控制面
 *
 * SDK 是 ESM-only（package.json type: module），所以主进程用动态 import() 载入。
 */

/** 单条奏折/问询的等待时长上限：超时不表态，交回上层决定。 */
const PENDING_TIMEOUT_MS = 30 * 60 * 1000;

/** transcript 在主进程只保留尾部，完整历史由渲染层累积。 */
const TAIL_MAX = 200;

/* ============================================================
   可推入的异步队列 —— query() 的 prompt 需要一个 AsyncIterable
   ============================================================ */
class PushQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }

  push(item) {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/* ============================================================
   纯函数：SDKMessage → { events, items }
   抽成纯函数是为了能在 probe 里用合成消息自检，不需要真实凭据。
   ============================================================ */

/**
 * @param {object} msg 一条 SDKMessage
 * @param {string} sessionId 我们自己的会话 id（不是 SDK 的 session_id）
 * @returns {{events: object[], items: object[]}}
 *   events —— 喂给 SessionStore 的归一化事件（沿用既有词汇，状态机不用改）
 *   items  —— 喂给阅读面板的 transcript 条目
 */
function normalize(msg, sessionId) {
  const events = [];
  const items = [];
  const base = { session_id: sessionId };

  switch (msg && msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        events.push({
          ...base,
          kind: 'session_start',
          agent: 'claude-code',
          model: msg.model,
          cwd: msg.cwd,
          project: lastPathSegment(msg.cwd),
        });
        items.push(item('system', `会话就绪 · ${msg.model || '默认模型'} · ${msg.permissionMode || 'default'} 模式`));
      }
      break;
    }

    case 'assistant': {
      const content = (msg.message && msg.message.content) || [];
      for (const block of content) {
        if (block.type === 'text' && block.text && block.text.trim()) {
          items.push(item('assistant', block.text));
          events.push({ ...base, kind: 'say', text: block.text });
        } else if (block.type === 'thinking' && block.thinking) {
          items.push(item('thinking', block.thinking));
          events.push({ ...base, kind: 'say', text: block.thinking });
        } else if (block.type === 'tool_use') {
          items.push({
            ...item('tool', describeToolCall(block.name, block.input)),
            tool: block.name,
            toolUseId: block.id,
          });
          events.push({ ...base, kind: 'tool_pre', tool: block.name });
        }
      }
      if (msg.error) {
        items.push(item('error', `模型返回错误：${msg.error}`));
      }
      break;
    }

    case 'user': {
      // 工具结果是以 user 角色回灌的
      const content = (msg.message && msg.message.content) || [];
      if (typeof content === 'string') break;
      for (const block of content) {
        if (block.type === 'tool_result') {
          items.push({
            ...item('tool_result', flattenToolResult(block.content)),
            ok: !block.is_error,
            toolUseId: block.tool_use_id,
          });
          events.push({ ...base, kind: 'tool_post' });
        }
      }
      break;
    }

    case 'stream_event': {
      // 流式增量：只取文本与思考的 delta，用于「边生成边读」
      const ev = msg.event;
      if (ev && ev.type === 'content_block_delta' && ev.delta) {
        if (ev.delta.type === 'text_delta' && ev.delta.text) {
          items.push({ ...item('assistant', ev.delta.text), partial: true, index: ev.index });
        } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
          items.push({ ...item('thinking', ev.delta.thinking), partial: true, index: ev.index });
        }
      }
      break;
    }

    case 'result': {
      const failed = msg.subtype && msg.subtype !== 'success';
      if (failed) {
        items.push(item('error', `本轮结束于 ${msg.subtype}`));
      }
      events.push({
        ...base,
        kind: 'stop',
        text: typeof msg.result === 'string' ? msg.result : '',
      });
      break;
    }

    case 'permission_denied': {
      items.push(item('notice', `已拒绝 ${msg.tool_name}${msg.decision_reason ? `：${msg.decision_reason}` : ''}`));
      break;
    }

    case 'compact_boundary': {
      items.push(item('notice', '上下文已压缩'));
      break;
    }

    case 'informational': {
      if (msg.content) items.push(item('notice', String(msg.content)));
      break;
    }

    case 'conversation_reset': {
      items.push(item('notice', '会话已重置'));
      break;
    }

    default:
      break;
  }

  return { events, items };
}

function item(kind, text) {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind,
    text: String(text == null ? '' : text),
  };
}

function lastPathSegment(p) {
  if (!p) return '';
  const parts = String(p).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || '';
}

/** 把工具调用写成人能扫一眼看懂的一行。 */
function describeToolCall(name, input) {
  const n = String(name || 'tool');
  if (!input || typeof input !== 'object') return n;
  const first =
    input.command ||
    input.file_path ||
    input.path ||
    input.pattern ||
    input.query ||
    input.url ||
    input.prompt ||
    input.description;
  return first ? `${n}: ${String(first).replace(/\s+/g, ' ').slice(0, 160)}` : n;
}

/** tool_result 的 content 可能是字符串，也可能是 block 数组。 */
function flattenToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content.slice(0, 4000);
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'image' ? '[图片]' : ''))
      .filter(Boolean)
      .join('\n')
      .slice(0, 4000);
  }
  return '';
}

/** 从 AskUserQuestion 的入参里抽出问题与选项。 */
function parseAskUserQuestion(input) {
  const qs = (input && input.questions) || [];
  const first = Array.isArray(qs) ? qs[0] : null;
  if (!first) return null;
  const options = (first.options || []).map((o) =>
    typeof o === 'string' ? o : o && (o.label || o.name || o.value || '')
  );
  return {
    question: first.question || first.header || '待选',
    options: options.filter(Boolean),
    multiSelect: Boolean(first.multiSelect),
  };
}

/* ============================================================
   会话
   ============================================================ */
class AgentSession extends EventEmitter {
  /**
   * @param {{id:string, cwd:string, model?:string, permissionMode?:string, title?:string}} cfg
   */
  constructor(cfg) {
    super();
    this.id = cfg.id || crypto.randomUUID();
    this.cwd = cfg.cwd || process.cwd();
    this.model = cfg.model;
    this.permissionMode = cfg.permissionMode || 'default';
    this.title = cfg.title || '';

    /**
     * 从哪些文件读设置。
     * 默认不传 → SDK 加载 user/project/local，行为和你平时用 Claude Code 一致
     * （包括你自己配的 allow 规则，那些工具不会来敲请奏，这是对的）。
     * 传 [] 则全部忽略，用于测试请奏链路本身。
     */
    this.settingSources = cfg.settingSources;
    this.allowedTools = cfg.allowedTools;
    this.disallowedTools = cfg.disallowedTools;

    this.input = new PushQueue();
    this.query = null;
    this.sdkSessionId = null;
    this.tail = [];
    /** requestId -> {resolve, timer, kind} */
    this.pending = new Map();
    this.closed = false;
    this.started = false;
  }

  /** 启动常驻会话。SDK 是 ESM，这里动态 import。 */
  async start() {
    if (this.started) return;
    this.started = true;

    const { query } = await import('@anthropic-ai/claude-agent-sdk');

    const options = {
      cwd: this.cwd,
      model: this.model,
      permissionMode: this.permissionMode,
        // 用 Claude Code 自己的系统提示与工具集，行为才和你平时用的一致
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        tools: { type: 'preset', preset: 'claude_code' },
        // 让「边生成边读」成立；没有它只能等整块文本落地
        includePartialMessages: true,
        // 权限一律交给桌宠上的奏折，这是产品的核心交互
        permissionPrompts: 'host',
      canUseTool: (toolName, input, opts) => this._onPermission(toolName, input, opts),
      stderr: (data) => this.emit('stderr', data),
    };

    // 只在显式给了值时才传，否则让 SDK 走自己的默认
    if (this.settingSources !== undefined) options.settingSources = this.settingSources;
    if (this.allowedTools !== undefined) options.allowedTools = this.allowedTools;
    if (this.disallowedTools !== undefined) options.disallowedTools = this.disallowedTools;

    this.query = query({ prompt: this.input, options });

    this._pump();
  }

  /** 消费 SDK 的消息流。 */
  async _pump() {
    try {
      for await (const msg of this.query) {
        if (msg && msg.session_id) this.sdkSessionId = msg.session_id;
        const { events, items } = normalize(msg, this.id);
        for (const ev of events) this.emit('event', ev);
        if (items.length) {
          for (const it of items) {
            if (!it.partial) {
              this.tail.push(it);
              if (this.tail.length > TAIL_MAX) this.tail.shift();
            }
          }
          this.emit('transcript', items);
        }
      }
      this.emit('event', { session_id: this.id, kind: 'session_end' });
    } catch (err) {
      if (this.closed) return;
      this.emit('transcript', [item('error', `会话中断：${err && err.message}`)]);
      this.emit('event', { session_id: this.id, kind: 'session_end' });
      this.emit('error', err);
    }
  }

  /**
   * canUseTool：这就是「请奏」。
   * SDK 只在权限流程落到「需要问人」时才调这里，被 allowedTools 或模式自动放行的不会来。
   */
  _onPermission(toolName, input, opts) {
    const requestId = opts.requestId || `req-${crypto.randomUUID()}`;

    const ask = toolName === 'AskUserQuestion' ? parseAskUserQuestion(input) : null;

    if (ask) {
      this.emit('event', {
        session_id: this.id,
        kind: 'question',
        request_id: requestId,
        question: ask.question,
        options: ask.options,
      });
      this.emit('transcript', [item('notice', `请择：${ask.question}`)]);
    } else {
      const { tier, reason } = classifyGrant(toolName, input);
      this.emit('event', {
        session_id: this.id,
        kind: 'permission_request',
        request_id: requestId,
        tool: toolName,
        input,
        summary: describeToolCall(toolName, input),
        tier,
        reason,
        decision_reason: opts.decisionReason,
        blocked_path: opts.blockedPath,
      });
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._settle(requestId, {
          behavior: 'deny',
          message: '桌宠等待超时，未获批复。如仍需执行请重新发起。',
        });
      }, PENDING_TIMEOUT_MS);
      if (timer.unref) timer.unref();

      this.pending.set(requestId, {
        resolve,
        timer,
        kind: ask ? 'choice' : 'grant',
        toolName,
        // 「永准」要把 SDK 给的建议原样回传，它才知道往哪条规则里写
        suggestions: opts.suggestions || [],
      });

      // 中止信号（会话被 interrupt/close）到了就别再挂着
      if (opts.signal) {
        opts.signal.addEventListener(
          'abort',
          () => this._settle(requestId, { behavior: 'deny', message: '已中止。' }),
          { once: true }
        );
      }
    });
  }

  _settle(requestId, result) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    try {
      p.resolve(result);
    } catch {
      /* 会话可能已经关掉，忽略 */
    }
    this.emit('event', { session_id: this.id, kind: 'resolved', decision: result.behavior });
    return true;
  }

  /** 桌宠上按了准奏 / 永准 / 驳回。 */
  decide(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p) return false;

    if (decision === 'allow') {
      return this._settle(requestId, { behavior: 'allow' });
    }
    if (decision === 'always') {
      // 把 SDK 建议的规则写回去，下次同类不再问
      return this._settle(requestId, { behavior: 'allow', updatedPermissions: p.suggestions });
    }
    return this._settle(requestId, {
      behavior: 'deny',
      message: '已驳回。请改用别的做法，或先向我说明理由。',
    });
  }

  /**
   * 请择的落子。
   *
   * 注意：把选择结果通过 deny 的 message 回灌给模型，是目前可确定生效的通路
   * —— deny 的 message 会作为 tool_result 交回模型阅读。
   * 是否存在「allow + updatedInput 直接带上答案」的官方路径尚未在真实会话里验证过，
   * 验证后再换成更正的那条。
   */
  choose(requestId, optionText) {
    const p = this.pending.get(requestId);
    if (!p) return false;
    return this._settle(requestId, {
      behavior: 'deny',
      message: `用户已选择：${optionText}。请按此继续，不要再次询问。`,
    });
  }

  /** 在桌宠里打字发出去。 */
  send(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed || this.closed) return null;

    const uuid = crypto.randomUUID();
    this.input.push({
      type: 'user',
      message: { role: 'user', content: trimmed },
      parent_tool_use_id: null,
      // 官方明确要求宿主转发键盘输入时显式打上 human，
      // 否则被当作来源不明，某些需要「真人输入」的检查会拒绝
      origin: { kind: 'human' },
      uuid,
    });

    const it = item('user', trimmed);
    this.tail.push(it);
    if (this.tail.length > TAIL_MAX) this.tail.shift();
    this.emit('transcript', [it]);
    this.emit('event', { session_id: this.id, kind: 'prompt', text: trimmed });
    return uuid;
  }

  async interrupt() {
    if (!this.query) return;
    try {
      await this.query.interrupt();
      this.emit('transcript', [item('notice', '已打断')]);
    } catch (err) {
      this.emit('transcript', [item('error', `打断失败：${err && err.message}`)]);
    }
  }

  async setPermissionMode(mode) {
    if (!this.query) return;
    try {
      await this.query.setPermissionMode(mode);
      this.permissionMode = mode;
      this.emit('transcript', [item('notice', `权限模式切到 ${mode}`)]);
    } catch (err) {
      this.emit('transcript', [item('error', `切换权限模式失败：${err && err.message}`)]);
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    // 先把挂着的奏折全部驳回，别让 SDK 那侧永久阻塞
    for (const [id] of this.pending) {
      this._settle(id, { behavior: 'deny', message: '桌宠已退出。' });
    }
    this.input.close();
    try {
      if (this.query && this.query.close) await this.query.close();
    } catch {
      /* 进程可能已经没了 */
    }
  }
}

/* ============================================================
   会话管理器
   ============================================================ */
class AgentManager extends EventEmitter {
  constructor() {
    super();
    /** id -> AgentSession */
    this.sessions = new Map();
  }

  async spawn(cfg) {
    const s = new AgentSession(cfg);
    this.sessions.set(s.id, s);
    s.on('event', (ev) => this.emit('event', ev));
    s.on('transcript', (items) => this.emit('transcript', { sessionId: s.id, items }));
    s.on('error', (err) => this.emit('session-error', { sessionId: s.id, err }));
    s.on('stderr', (d) => this.emit('stderr', { sessionId: s.id, data: d }));
    await s.start();
    return s;
  }

  get(id) {
    return this.sessions.get(id);
  }

  /** 关掉单个会话(人在桌宠上点了「结束会话」)。没有内核的旁路会话返回 false。 */
  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this.sessions.delete(id);
    await s.close();
    return true;
  }

  async closeAll() {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
  }
}

module.exports = {
  AgentManager,
  AgentSession,
  PushQueue,
  normalize,
  describeToolCall,
  parseAskUserQuestion,
  flattenToolResult,
  PENDING_TIMEOUT_MS,
};
