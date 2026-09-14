/**
 * 折叠态身份名牌的文本计算。
 *
 * 单独成文件（而且是 .mjs）只有一个理由：**能被 node 直接 import 来做单测**。
 * pet.js 一进来就 boot()、满篇 document，放在里面的纯函数没法在命令行验证；
 * 而这两条规则恰恰是量出来的、最怕被人随手改坏的部分，所以要能测。
 * 包目录是 CJS（package.json 没有 type: module），.js 会被 node 当 CJS 解析，
 * 所以扩展名用 .mjs —— 浏览器侧照常按 ESM 加载，两边都能吃。
 *
 * 两条结论都来自 84px 舞台上的实测（见 docs/kiro-deep-support.md）：
 *   ① 名牌必须用**会话标题**而不是目录名：同一个工程开三个会话时，
 *      目录名让三只宠物长得一模一样，等于没做这个功能。
 *   ② 11px 字最多放 4 个汉字：10px/5 字开始糊，9px/6 字完全认不出。
 *      所以按**视觉宽度**截断（全角 2、半角 1，上限 8 个单位），
 *      而不是 slice(0, 4) —— 标题是 "fix login bug" 这种纯英文时，
 *      4 个字符只剩 "fix "，没有任何信息量。
 */

/** 8 个半角单位 = 4 个汉字。 */
export const IDENT_MAX_UNITS = 8;

/** 名牌文本的来源，按信息量降级：会话标题 → 项目名 → 客户端名。 */
export function identSource(s) {
  const title = String((s && s.title) || '').trim();
  // 「等待 kiro 接入 · xxx」是占位文案，不是会话身份，退回项目名
  const usable = title && !/^等待\s/.test(title) ? title : '';
  return usable || String((s && s.project) || '').trim() || String((s && s.agent) || '').trim();
}

/** 按视觉宽度截断：CJK / 假名 / 全角标点算 2 个单位，其余算 1。 */
export function truncVisual(text, maxUnits = IDENT_MAX_UNITS) {
  let units = 0;
  let out = '';
  for (const ch of String(text || '')) {
    const wide = ch.codePointAt(0) >= 0x2e80; // CJK / 假名 / 全角标点起点
    const w = wide ? 2 : 1;
    if (units + w > maxUnits) break;
    units += w;
    out += ch;
  }
  return out;
}

/**
 * 这只宠物该显示什么名牌。返回空串 = 不显示。
 * @param {object} s store.snapshot() 里的单条
 */
export function identLabel(s) {
  if (!s) return '';
  const view = s.view || (s.collapsed ? 'collapsed' : 'card');
  // 只在折叠态、且桌面上不止一只时才挂：
  // 独苗压根不存在"分不清哪只是哪只"的问题，挂了只是白遮住脚。
  if (view !== 'collapsed' || (s.petCount || 1) <= 1) return '';
  return truncVisual(identSource(s).replace(/\s+/g, ' '), IDENT_MAX_UNITS);
}
