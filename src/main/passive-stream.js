'use strict';

const crypto = require('crypto');

const { classifyGrant } = require('./states');

/**
 * 旁路会话（kiro / codex 这类靠 hook 上报的）的阅读流。
 *
 * 为什么要单独一个模块：
 * 桌宠原生驱动的 Claude 会话有 AgentSession，阅读流由它的 `tail` 累积；
 * 而旁路会话没有内核实例，`agents.get(id)` 取不到东西 —— 结果是会话面板
 * 一片空白，只能干看着状态。这个类就是给旁路会话补上那份 `tail`。
 *
 * 一条重要的纠正：早先的结论「hook 拿不到正文，阅读流永远是空的」是错的。
 * kiro 的 `PostToolUse` payload 里带 **`tool_response`**（工具的真实输出），
 * `PreToolUse` 带 `tool_input`（含命令、路径、待写入内容）。
 * agent 干活的主体就是工具调用和它们的输出，缺的只有 assistant 的自然语言旁白。
 * 所以阅读流是**能读的**，只是读到的是「动作 + 结果」而不是「它在说什么」。
 *
 * 内存上限：每只宠物只留尾部 TAIL_MAX 条，完整历史由渲染层自己累积
 * （跟 AgentSession.tail 同一套策略，数值也对齐）。
 */

/** 与 agent.js 的 TAIL_MAX 对齐，改一个就要改另一个。 */
const TAIL_MAX = 200;

/** 单条工具输出留多长。hook 侧还会再截一次，这里是主进程侧的兜底。 */
const RESULT_MAX = 1200;

function item(kind, text, extra = {}) {
  return {
    id: crypto.randomUUID(),
    at: Date.now(),
    kind,
    text: String(text == null ? '' : text),
    ...extra,
  };
}

function clip(text, max) {
  const one = String(text == null ? '' : text);
  return one.length > max ? `${one.slice(0, max)}\n…（已截断）` : one;
}

/** 把工具名 + 入参写成一行人能扫一眼看懂的话。 */
function describe(tool, input) {
  const n = String(tool || 'tool');
  if (!input || typeof input !== 'object') return n;
  const first =
    input.command ||
    input.path ||
    input.file_path ||
    input.filePath ||
    input.targetFile ||
    input.query ||
    input.url ||
    input.pattern;
  return first ? `${n}: ${String(first).replace(/\s+/g, ' ').slice(0, 160)}` : n;
}

class PassiveStream {
  constructor({ tailMax = TAIL_MAX } = {}) {
    this.tailMax = tailMax;
    /** sessionId -> item[] */
    this.tails = new Map();
  }

  tailOf(sessionId) {
    return this.tails.get(sessionId) || [];
  }

  drop(sessionId) {
    this.tails.delete(sessionId);
  }

  clear() {
    this.tails.clear();
  }

  /**
   * 吃一条 hook 事件，产出要追加到阅读流的条目。
   *
   * @param {object} ev  hook 上报的原始事件（含 kind / tool / input / result …）
   * @param {string} sessionId  store 归一后的宠物 id（**不是** ev.session_id，
   *   旁路 id 会被 _resolveId 认领到别的宠物身上，用错了会写到隔壁的流里）
   * @returns {object[]} 新增条目；没有可显示内容时返回空数组
   */
  ingest(ev, sessionId) {
    if (!ev || !sessionId) return [];
    const items = [];

    switch (ev.kind) {
      case 'prompt': {
        const text = String(ev.text || '').trim();
        if (text) items.push(item('user', text));
        break;
      }

      case 'tool_pre': {
        // 危险度三色：复用 states.js 那份判据，红/黄/蓝在渲染层做左边框着色。
        // 这里只打标签，**不阻塞**（阻塞是「请奏」那条路，走 /permission）。
        const { tier, reason } = classifyGrant(ev.tool, ev.input);
        items.push(
          item('tool', describe(ev.tool, ev.input), {
            tool: ev.tool || '',
            tier,
            ...(reason ? { tierReason: reason } : {}),
          })
        );
        break;
      }

      case 'tool_post': {
        const out = clip(ev.result, RESULT_MAX).trim();
        // 有些工具压根不返回内容（比如纯副作用的写文件），别塞一条空气泡进去
        if (out) items.push(item('tool_result', out, { ok: ev.ok !== false, tool: ev.tool || '' }));
        else if (ev.ok === false) items.push(item('tool_result', `${ev.tool || '工具'} 失败`, { ok: false }));
        break;
      }

      case 'permission_request': {
        const label = ev.summary || describe(ev.tool, ev.input);
        items.push(item('notice', `请奏：${label}`));
        break;
      }

      case 'resolved': {
        const map = { allow: '准奏', always: '永准', deny: '驳回', defer: '未表态，交回客户端' };
        items.push(item('notice', map[ev.decision] || String(ev.decision || '')));
        break;
      }

      case 'stop': {
        items.push(item('notice', '这一轮跑完了'));
        break;
      }

      default:
        // session_start / say 之类不进阅读流：前者是噪音，后者旁路通道压根没有
        break;
    }

    if (!items.length) return [];

    const tail = this.tails.get(sessionId) || [];
    tail.push(...items);
    while (tail.length > this.tailMax) tail.shift();
    this.tails.set(sessionId, tail);
    return items;
  }
}

module.exports = { PassiveStream, TAIL_MAX, RESULT_MAX, _describe: describe, _clip: clip };
