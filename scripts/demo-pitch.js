'use strict';

const http = require('http');

/**
 * 录制用剧本（`npm run pitch`）—— 30 秒紧凑版。
 *
 * 和 scripts/demo.js 的分工：
 *   demo.js   —— 验证用。覆盖状态机的边角，是给开发看的。
 *   这一份    —— 录 30 秒开源 README 用。全程自动跑完、不停下等人点,
 *               这样一镜到底录屏正好压在 30s 内。
 *
 * 一屏塞下三件核心卖点，按「一眼能看懂」的顺序：
 *   ① 一排宠物、脚下名牌各不同 —— 多会话时分得清谁是谁（含同项目两只）
 *   ② 会话面板里的阅读流 + 危险度三色 —— 不打开 kiro 也知道它在干什么
 *   ③ 两只「同时」弹请奏、各批各的 —— 多 session 各自独立审批
 *
 * ②③ 走真实 HTTP 通道（/event 带 tool_input、/permission 真阻塞后回灌），
 * 三色和拦截都是真判的，不是摆拍。审批那步为了压时长不等人点：抛出后停 2.5s
 * 让卡片露脸,脚本自动 deny 红奏 / allow 蓝奏,演出「驳回 vs 准奏」的效果。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(port, path, body, { timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('pitch request timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 导播提示：显眼一点，录制时要能在终端里一眼看到 */
function cue(no, what, action) {
  const bar = '─'.repeat(58);
  console.log(`\n${bar}\n【镜头 ${no}】${what}`);
  if (action) console.log(`   ▶ 你要做的：${action}`);
  console.log(bar);
}

/** 倒计时，让你知道下一个镜头什么时候来 */
async function hold(sec, note) {
  for (let i = sec; i > 0; i -= 1) {
    if (i % 5 === 0 || i <= 3) {
      process.stdout.write(`\r   ${note} … ${i}s   `);
    }
    await sleep(1000);
  }
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
}

async function run({ port }) {
  const ev = (b) => post(port, '/event', b).catch((e) => console.error('[pitch]', e.message));
  const view = (session_id, v) => post(port, '/view', { session_id, view: v }).catch(() => {});
  const decide = (request_id, decision) =>
    post(port, '/decision', { request_id, decision, note: 'pitch-auto' }).catch(() => {});

  // 刻意让 A、B 同项目、不同标题 —— 名牌要解决的正是这种情况
  const A = 'demo-live';
  const B = 'demo-audit';
  const C = 'demo-xhs';

  console.log('\n桌宠 30 秒演示 · 全自动跑完，不用手点');
  console.log('录屏：Cmd+Shift+5 选「录制选定部分」，框住屏幕左下角一条 —— 宠物都排在左侧。');
  console.log('现在开始，约 2 秒后进第一幕。');
  await sleep(2000);

  /* ───────── 幕 1（0~6s）：三只登场，名牌各不同 ───────── */
  cue(1, '三只宠物登场，站成一排（脚下名牌各不同）', '看每只脚下的名牌：前两只同属 CenterSite，靠标题区分');
  await ev({ session_id: A, kind: 'session_start', agent: 'kiro', project: 'CenterSite', cwd: '/repo/centersite', title: 'AI总结迁移' });
  await sleep(700);
  await ev({ session_id: B, kind: 'session_start', agent: 'kiro', project: 'CenterSite', cwd: '/repo/centersite2', title: '稽核SQL口径' });
  await sleep(700);
  await ev({ session_id: C, kind: 'session_start', agent: 'kiro', project: 'my-skills', cwd: '/repo/my-skills', title: '小红书选题' });
  // 第一只立刻进入运行中，露一下跑步动画
  await ev({ session_id: A, kind: 'prompt', text: '把 AI 总结的三级分类迁到新表' });
  await ev({ session_id: A, kind: 'tool_pre', tool: 'read_file', input: { path: 'src/summary/classifier.py' }, text: '正在 read_file · classifier.py' });
  await hold(4, '三只并排在屏幕左侧，第一只已在跑');

  /* ───────── 幕 2（6~16s）：阅读流 + 危险度三色 ───────── */
  cue(2, '点开会话面板：阅读流 + 危险度三色', '看消息流每行左边框：蓝=只读 / 黄=写入 / 红=危险');
  await view(A, 'chat');
  await sleep(1200);
  const steps = [
    ['read_file', { path: 'src/summary/classifier.py' }, 'class Classifier:\n    LEVELS = 3  # 共 218 行'],
    ['fs_write', { path: 'migrations/0042_move_category.sql', text: 'ALTER TABLE ...' }, 'Created the migrations/0042_move_category.sql file.'],
    ['execute_bash', { command: 'rm -rf build && git push --force origin main' }, 'error: failed to push some refs'],
  ];
  for (const [tool, input, result] of steps) {
    await ev({ session_id: A, kind: 'tool_pre', tool, input, text: `正在 ${tool}` });
    await sleep(900);
    await ev({ session_id: A, kind: 'tool_post', tool, result, ok: !/error|failed/i.test(result) });
    await sleep(700);
  }
  await hold(4, '蓝(读) → 黄(写) → 红(rm -rf & force push)，结果失败也标红');

  /* ───────── 幕 3（16~28s）：两只「同时」弹请奏，脚本自动各批各的 ───────── */
  cue(3, '两个会话「同时」弹请奏 —— 各自独立审批', '看两只宠物头上同时挂卡片：红奏(危险) + 蓝奏(只读)');
  await view(A, 'collapsed');
  await sleep(600);
  await ev({ session_id: B, kind: 'prompt', text: '清一下构建产物再推上去' });
  await ev({ session_id: C, kind: 'prompt', text: '看看 sitemap 配在哪' });

  // 两封请奏并发抛出，各自阻塞;不 await,让卡片先露脸
  const redP = post(port, '/permission', {
    session_id: B, request_id: 'pitch-red', tool: 'execute_bash',
    input: { command: 'rm -rf dist && git push --force origin main' },
    summary: 'execute_bash · rm -rf dist && git push --force origin main',
  });
  const blueP = post(port, '/permission', {
    session_id: C, request_id: 'pitch-blue', tool: 'grep_search',
    input: { query: 'sitemapLocation', includePattern: '**/*.json' },
    summary: 'grep_search · sitemapLocation',
  });
  await hold(5, '两只同时挂着等批（红=危险 / 蓝=只读）');

  // 自动回灌：驳回红奏、准奏蓝奏 —— 演出「各批各的、互不影响」
  console.log('   → 自动驳回红奏(B)、准奏蓝奏(C)…');
  await decide('pitch-red', 'deny');
  await sleep(1200);
  await decide('pitch-blue', 'allow');
  const [red, blue] = await Promise.all([redP, blueP]);
  console.log(`   B(红/危险)=${red.decision}  C(蓝/只读)=${blue.decision} —— 各批各的,互不影响。`);
  await hold(3, '红的被拦下、蓝的放行');

  /* ───────── 幕 4（28~30s）：收尾 ───────── */
  await ev({ session_id: A, kind: 'stop', text: '三级分类已迁完，跑过 218 条用例。' });
  cue(4, '干完活「复奏」跃起收尾', '第一只跳一下表示这一轮结束');
  console.log('\n30 秒演示结束。重来一遍：Ctrl+C 再 npm run pitch。\n');
}

module.exports = { run };
