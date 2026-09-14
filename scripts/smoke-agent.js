'use strict';

/**
 * 真实会话冒烟测试。
 *
 * 验证的是 probe.js 验不到的那一环：AgentSession 能不能真的起一个 Claude 会话，
 * 消息流能不能正常归一化，canUseTool（请奏）能不能真的挡住工具并被批复放行。
 *
 * 跑法：node scripts/smoke-agent.js
 * 前提：本机已完成 Claude Code 登录，或设了 ANTHROPIC_API_KEY。
 *
 * 不起 Electron —— agent.js 只依赖 events/crypto，是纯 Node 模块。
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { AgentSession } = require('../src/main/agent');

const TIMEOUT_MS = 120 * 1000;
const AUTO_APPROVE_AFTER_MS = 800; // 模拟人按下「准奏」

async function main() {
  // 在一次性目录里跑，不碰真实仓库
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aicp-smoke-'));
  fs.writeFileSync(path.join(cwd, 'hello.txt'), '桌宠冒烟测试用的文件。里面写着：紫罗兰\n', 'utf8');
  console.log(`工作目录 ${cwd}`);

  // 刻意不传 settingSources：要用和产品一致的配置跑。
  // 试过传 [] 来屏蔽既有 allow 规则，结果连认证一起丢了（认证配置就在
  // ~/.claude/settings.json 的 env 里），会话直接 403。
  const s = new AgentSession({ cwd });

  const seen = { events: [], items: [], grants: [] };
  let sawInit = false;
  let sawAssistantText = false;
  let sawToolUse = false;
  let sawResult = false;

  s.on('event', (ev) => {
    seen.events.push(ev.kind);
    if (ev.kind === 'session_start') {
      sawInit = true;
      console.log(`  [事件] 会话就绪 model=${ev.model} project=${ev.project}`);
    }
    if (ev.kind === 'tool_pre') sawToolUse = true;
    if (ev.kind === 'stop') sawResult = true;

    if (ev.kind === 'permission_request') {
      seen.grants.push(ev);
      console.log(`  [请奏] ${ev.tool} · ${ev.tier}${ev.reason ? ` (${ev.reason})` : ''}`);
      console.log(`         ${ev.summary}`);
      // 模拟在桌宠上点「准奏」
      setTimeout(() => {
        const ok = s.decide(ev.request_id, 'allow');
        console.log(`  [准奏] decide() 返回 ${ok}`);
      }, AUTO_APPROVE_AFTER_MS);
    }

    if (ev.kind === 'question') {
      console.log(`  [请择] ${ev.question} → ${JSON.stringify(ev.options)}`);
      setTimeout(() => s.choose(ev.request_id, ev.options[0]), AUTO_APPROVE_AFTER_MS);
    }
  });

  s.on('transcript', (items) => {
    for (const it of items) {
      if (it.partial) continue; // 增量太碎，冒烟只看完整块
      seen.items.push(it.kind);
      if (it.kind === 'assistant' && it.text.trim()) sawAssistantText = true;
      const head = it.text.replace(/\s+/g, ' ').slice(0, 96);
      console.log(`  [${it.kind}] ${head}`);
    }
  });

  s.on('error', (err) => console.error('  [错误]', err && err.message));
  s.on('stderr', (d) => {
    const t = String(d).trim();
    if (t) console.error('  [stderr]', t.slice(0, 200));
  });

  const done = new Promise((resolve) => {
    s.on('event', (ev) => {
      if (ev.kind === 'stop') setTimeout(resolve, 1200);
    });
  });

  console.log('启动会话…');
  await s.start();

  /*
   * 选什么任务，决定了能不能验到请奏。
   * canUseTool 只在权限流程「落到要问人」时才被调用，被 allow 规则或权限模式
   * 自动放行的工具压根不会来。踩过两次空：
   *   - cwd 内的 Read → default 模式自动放行
   *   - Bash → 本机 settings.local.json 里有 Bash(*)，全量放行
   * Write 不在放行名单里，所以用「新建一个文件」来触发。
   */
  s.send('在当前目录新建一个文件 note.md，内容写一行「紫罗兰」。写完只回答“done”。');

  const timeout = new Promise((_r, rej) => setTimeout(() => rej(new Error('超时')), TIMEOUT_MS));
  try {
    await Promise.race([done, timeout]);
  } finally {
    await s.close();
  }

  console.log('\n结论');
  const checks = [
    ['会话起来了（收到 init）', sawInit],
    ['收到 assistant 正文', sawAssistantText],
    ['触发了工具调用', sawToolUse],
    ['请奏被拦下并放行', seen.grants.length > 0],
    ['本轮正常结束（收到 result）', sawResult],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    if (!ok) bad += 1;
  }
  console.log(`\n事件序列: ${dedupe(seen.events).join(' → ')}`);
  console.log(`条目类型: ${[...new Set(seen.items)].join(', ')}`);

  fs.rmSync(cwd, { recursive: true, force: true });

  // 请奏那条允许为 0：权限模式或已有 allow 规则可能让它免奏，不算失败
  const fatal = !sawInit || !sawAssistantText || !sawResult;
  process.exit(fatal ? 1 : 0);
}

function dedupe(arr) {
  return arr.filter((v, i) => v !== arr[i - 1]);
}

main().catch((err) => {
  console.error('\n冒烟失败:', err && err.message);
  console.error(
    '\n如果是认证问题：桌宠通过 Claude Agent SDK 驱动会话，' +
      '需要本机已 claude login，或设置 ANTHROPIC_API_KEY。'
  );
  process.exit(1);
});
