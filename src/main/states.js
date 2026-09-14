'use strict';

/**
 * 状态机定义。
 *
 * 状态取自飞书文档《My ai coding pet》结论 3：
 *   运行中 / 等授权 / 等选择确认 / 运行完成
 *   + 超时未回复交互 / 请奏退出 / 请奏退出超时（瘫状态）
 *
 * 设计约束：
 * - needsHuman 为 true 的状态才允许抢占「唯一展开位」（文档结论 1）。
 * - priority 只用于排序与抢占仲裁，不用于把多 session 合并成一只宠物
 *   （文档结论 2 明确要求每 session 一只，这点和 clawd-on-desk 相反）。
 */

const S = {
  IDLE: 'idle',
  RUNNING: 'running',
  AWAITING_GRANT: 'awaiting_grant', // 等授权（请奏），红黄蓝三级
  AWAITING_CHOICE: 'awaiting_choice', // 等选择确认（请择）
  DONE: 'done',
  STALE: 'stale', // 等待超时未回复
  EXITING: 'exiting', // 请奏退出
  LIMP: 'limp', // 请奏退出超时 → 瘫
};

const META = {
  [S.IDLE]: { priority: 0, needsHuman: false, terminal: false },
  [S.DONE]: { priority: 10, needsHuman: false, terminal: true },
  [S.RUNNING]: { priority: 20, needsHuman: false, terminal: false },
  [S.LIMP]: { priority: 30, needsHuman: false, terminal: true },
  [S.EXITING]: { priority: 40, needsHuman: true, terminal: false },
  [S.STALE]: { priority: 50, needsHuman: true, terminal: false },
  [S.AWAITING_CHOICE]: { priority: 60, needsHuman: true, terminal: false },
  [S.AWAITING_GRANT]: { priority: 70, needsHuman: true, terminal: false },
};

/** 等授权三色分级。红=破坏性且难恢复，黄=写入或执行，蓝=只读。 */
const TIER = { RED: 'red', AMBER: 'amber', BLUE: 'blue' };

/**
 * 破坏性命令特征。
 * 刻意写得保守：宁可误判成红（多问你一句），不可漏判成蓝（悄悄放过）。
 * 每条都是「真的不可逆或影响面很大」的操作，不做只为了好看的规则。
 */
const RED_PATTERNS = [
  /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, // rm -rf / rm -fr / rm -r -f
  /\brmdir\b/i,
  /\bgit\s+push\b[^\n]*\s(--force\b|-f\b)/i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fd]/i,
  /\bgit\s+branch\s+-D\b/i,
  /\bgit\s+checkout\s+--\s+\./i,
  /\bdrop\s+(table|database|schema)\b/i,
  /\btruncate\s+table\b/i,
  /\bdelete\s+from\b(?![\s\S]*\bwhere\b)/i, // 无 WHERE 的 DELETE
  /\bupdate\s+\S+\s+set\b(?![\s\S]*\bwhere\b)/i, // 无 WHERE 的 UPDATE
  /\bchmod\s+(-R\s+)?777\b/i,
  /\bchown\s+-R\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\b/i,
  />\s*\/dev\/(sd|nvme|disk)/i,
  /\bnpm\s+publish\b/i,
  /\bdocker\s+(system\s+prune|rmi|volume\s+rm)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+(destroy|apply)\b/i,
  /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, // 管道进 shell
  /\bsudo\b/i,
  /\bkillall\b|\bpkill\s+-9\b/i,
  /\bshutdown\b|\breboot\b/i,
];

/** 写入 / 执行类工具名（各家 agent 的叫法都收进来）。 */
const WRITE_TOOLS = new Set([
  'bash', 'shell', 'run', 'execute', 'execute_bash', 'executebash', 'terminal',
  'write', 'edit', 'multiedit', 'str_replace', 'strreplace', 'fs_write',
  'fs_append', 'fsappend', 'fswrite', 'create', 'delete', 'delete_file',
  'notebookedit', 'applypatch', 'apply_patch', 'patch',
]);

/** 只读类工具名。 */
const READ_TOOLS = new Set([
  'read', 'readfile', 'read_file', 'read_files', 'readmultiplefiles', 'view',
  'grep', 'grep_search', 'glob', 'ls', 'list', 'list_directory', 'listdirectory',
  'search', 'file_search', 'filesearch', 'codebase_search', 'read_code',
  'fetch', 'web_fetch', 'webfetch', 'websearch', 'web_search', 'remote_web_search',
  'todo_list', 'todolist',
]);

function normalizeTool(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

/**
 * 把 hook 送来的 (工具名, 入参) 判成红/黄/蓝。
 *
 * @param {string} toolName
 * @param {unknown} toolInput  原始入参，对象会被摊平成文本再匹配
 * @returns {{tier: string, reason: string|null}}
 */
function classifyGrant(toolName, toolInput) {
  const tool = normalizeTool(toolName);
  const text = flatten(toolInput);

  for (const re of RED_PATTERNS) {
    const m = text.match(re);
    if (m) {
      return { tier: TIER.RED, reason: m[0].trim().slice(0, 80) };
    }
  }

  // 工具名本身就是删除语义
  if (tool.includes('delete') || tool.includes('remove')) {
    return { tier: TIER.RED, reason: toolName };
  }

  if (WRITE_TOOLS.has(tool)) return { tier: TIER.AMBER, reason: null };
  if (READ_TOOLS.has(tool)) return { tier: TIER.BLUE, reason: null };

  // 认不出来的一律算黄。低估风险的代价比多问一句大。
  return { tier: TIER.AMBER, reason: null };
}

/** 把任意入参摊平成可做正则匹配的一段文本。 */
function flatten(input, depth = 0) {
  if (input == null) return '';
  if (depth > 4) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return input.map((v) => flatten(v, depth + 1)).join('\n');
  if (typeof input === 'object') {
    return Object.values(input).map((v) => flatten(v, depth + 1)).join('\n');
  }
  return '';
}

function priorityOf(state) {
  return (META[state] || META[S.IDLE]).priority;
}

function needsHuman(state) {
  return Boolean((META[state] || {}).needsHuman);
}

function isTerminal(state) {
  return Boolean((META[state] || {}).terminal);
}

module.exports = {
  S,
  META,
  TIER,
  classifyGrant,
  priorityOf,
  needsHuman,
  isTerminal,
  normalizeTool,
  _flatten: flatten,
  _RED_PATTERNS: RED_PATTERNS,
};
