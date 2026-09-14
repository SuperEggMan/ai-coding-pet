'use strict';

const http = require('http');

/**
 * Demo 剧本。
 *
 * 刻意走真实的 HTTP 通道而不是直接改 store，这样一次 demo 就把
 * hook 入口 → 状态机 → 窗口管理 → 渲染层 → 阻塞式审批回灌
 * 整条链都验证了。请奏那两步是真的阻塞在这里等你点准奏/驳回。
 */

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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('demo request timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ port }) {
  console.log('[demo] 剧本开始。请奏两步会真的阻塞，等你在宠物上点按钮。');

  const A = 'demo-session-A';
  const B = 'demo-session-B';
  const C = 'demo-session-C';

  const ev = (body) => post(port, '/event', body).catch((e) => console.error('[demo]', e.message));

  let seq = 0;
  const tx = (session_id, items) =>
    post(port, '/transcript', {
      session_id,
      items: items.map((i) => ({ id: `d${++seq}`, at: Date.now(), ...i })),
    }).catch((e) => console.error('[demo]', e.message));

  /** 逐字吐出来，验证流式增量归并与自动跟随滚动 */
  async function stream(session_id, kind, text, index = 0, chunk = 6, gap = 26) {
    for (let i = 0; i < text.length; i += chunk) {
      await tx(session_id, [{ kind, text: text.slice(i, i + chunk), partial: true, index }]);
      await sleep(gap);
    }
    await tx(session_id, [{ kind, text }]); // 完整块收尾
  }

  // ---- A：正常一轮，最后走 复奏 → 请退 → 瘫 的升级链 ----
  await ev({
    session_id: A, kind: 'session_start',
    agent: 'kiro', project: 'my-skills', model: 'claude-opus-5', cwd: '/repo/my-skills',
  });
  await sleep(400);
  await tx(A, [{ kind: 'system', text: '会话就绪 · claude-opus-5 · default 模式' }]);

  const prompt = '把飞书文档里的 7 条结论落成一个可跑的桌宠';
  await ev({ session_id: A, kind: 'prompt', text: prompt });
  await tx(A, [{ kind: 'user', text: prompt }]);
  await sleep(500);

  await stream(A, 'thinking', '先确认状态机怎么组织，再决定图层怎么切。位姿表和插值引擎要分开，皮肤只描述目标位姿。');
  await sleep(200);
  await stream(A, 'assistant', '我先读现有实现，确认八个状态的位姿表结构，再动手。');

  await ev({ session_id: A, kind: 'tool_pre', tool: 'read_file' });
  await tx(A, [{ kind: 'tool', text: 'Read: src/main/store.js', tool: 'Read' }]);
  await sleep(700);
  await tx(A, [{ kind: 'tool_result', text: '读到 380 行，状态机在 SessionStore.apply()', ok: true }]);
  await sleep(500);

  await ev({ session_id: A, kind: 'tool_pre', tool: 'fs_write' });
  await tx(A, [{ kind: 'tool', text: 'Write: src/skins/zhunzou/skin.json', tool: 'Write' }]);
  await sleep(600);
  await tx(A, [{ kind: 'tool_result', text: 'ENOENT: 目录不存在', ok: false }]);
  await sleep(600);

  // ---- B：并发第二个会话，抛一封蓝色例奏（只读，风险最低）----
  await ev({
    session_id: B, kind: 'session_start',
    agent: 'claude-code', project: 'beijing-camera', model: 'sonnet-4.6', cwd: '/repo/bj',
  });
  await sleep(400);
  await ev({ session_id: B, kind: 'prompt', text: '排查小程序 sitemap 配置' });
  await sleep(800);

  console.log('[demo] B 抛出例奏（蓝）—— 阻塞等你处理');
  const blue = await post(port, '/permission', {
    session_id: B,
    request_id: 'demo-blue',
    tool: 'grep_search',
    input: { query: 'sitemapLocation', includePattern: '**/*.json' },
    summary: 'grep_search: sitemapLocation',
  });
  console.log('[demo] 例奏结果 =', blue.decision);
  await sleep(700);

  // ---- A：红色急奏（破坏性），验证三色分级与 reason 回显 ----
  console.log('[demo] A 抛出急奏（红）—— 阻塞等你处理');
  const red = await post(port, '/permission', {
    session_id: A,
    request_id: 'demo-red',
    tool: 'execute_bash',
    input: { command: 'git push --force origin main' },
    summary: 'execute_bash: git push --force origin main',
  });
  console.log('[demo] 急奏结果 =', red.decision);
  await sleep(600);

  // ---- C：等选择确认 ----
  await ev({
    session_id: C, kind: 'session_start',
    agent: 'codex', project: 'absurd-apps', model: 'gpt-5.2', cwd: '/repo/absurd',
  });
  await sleep(400);
  await ev({ session_id: C, kind: 'prompt', text: '桌宠皮肤先做哪一版' });
  await sleep(700);
  await ev({
    session_id: C,
    kind: 'question',
    request_id: 'demo-choice',
    question: '先做哪一版皮肤？',
    options: ['准奏盖章版', '言情版', '宫斗版'],
  });
  await sleep(400);

  // ---- A 收尾：complete → 之后靠 store 的超时链自己升级 ----
  await ev({ session_id: A, kind: 'tool_post', tool: 'fs_write' });
  await sleep(900);
  await ev({ session_id: A, kind: 'stop', text: '八态位姿与插值引擎已就位，三色分级按危险度判定。' });

  console.log('[demo] A 已复奏。45s 不理会自动转「请退」，再 60s 转「瘫」。');
  console.log('[demo] 点宠物 = 档位轮转（折叠→状态卡→会话面板）；终态点一下 = 收掉。');

  // 把 A 摊到会话面板，展示「不开 agent 界面也能读全文 + 直接吩咐」
  await sleep(500);
  await post(port, '/view', { session_id: A, view: 'chat' }).catch(() => {});
  await stream(A, 'assistant', '八态位姿与插值引擎已就位，三色分级按危险度判定。你可以直接在这个面板里继续吩咐。');
}

module.exports = { run };
