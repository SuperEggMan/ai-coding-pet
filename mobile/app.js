'use strict';

/* 手机端只读镜像。token 从配对链接的 ?t= 带进来。 */

const token = new URLSearchParams(location.search).get('t') || '';
const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const connEl = document.getElementById('conn');

const LABEL = {
  idle: '待命',
  running: '运行中',
  awaiting_grant: '请奏',
  awaiting_choice: '请择',
  done: '复奏',
  stale: '久候',
  exiting: '请退',
  limp: '瘫',
};

const ACCENT = {
  idle: '#8f9bb3',
  running: '#3f7fbf',
  awaiting_grant: '#d7382b',
  awaiting_choice: '#e08b1f',
  done: '#2f9e6b',
  stale: '#c2571f',
  exiting: '#7a6a52',
  limp: '#8f9bb3',
};

const TIER_LABEL = { red: '急奏', amber: '常奏', blue: '例奏' };
const TIER_COLOR = { red: '#d7382b', amber: '#e08b1f', blue: '#3f7fbf' };
const URGENT = new Set(['awaiting_grant', 'awaiting_choice', 'stale']);

let ws = null;
let retry = 0;

connect();

function connect() {
  if (!token) {
    connEl.textContent = '缺少配对 token';
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?t=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    retry = 0;
    connEl.textContent = '已连接';
    connEl.dataset.up = '1';
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') render(msg.sessions || []);
  };

  ws.onclose = (e) => {
    connEl.dataset.up = '0';
    connEl.textContent = e.code === 4001 ? 'token 已轮换，请重新配对' : '已断开，重连中…';
    if (e.code === 4001) return;
    // 指数退避，最多 10s
    retry = Math.min(retry + 1, 5);
    setTimeout(connect, 400 * 2 ** retry);
  };

  ws.onerror = () => {
    connEl.dataset.up = '0';
    connEl.textContent = '连接异常';
  };
}

function render(sessions) {
  emptyEl.hidden = sessions.length > 0;
  listEl.textContent = '';

  for (const s of sessions) {
    const li = document.createElement('li');
    li.style.borderLeftColor = ACCENT[s.state] || '#8f9bb3';
    if (URGENT.has(s.state)) li.dataset.urgent = '1';

    const row = document.createElement('div');
    row.className = 'row1';

    if (s.tier && TIER_LABEL[s.tier]) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.style.background = TIER_COLOR[s.tier];
      b.textContent = TIER_LABEL[s.tier];
      row.appendChild(b);
    }

    const proj = document.createElement('span');
    proj.className = 'proj';
    proj.textContent = s.project || s.agent || '未知';
    row.appendChild(proj);

    const st = document.createElement('span');
    st.className = 'st';
    st.style.color = ACCENT[s.state] || '#8f9bb3';
    st.textContent = LABEL[s.state] || s.state;
    row.appendChild(st);

    li.appendChild(row);

    if (s.liveLine) {
      const p = document.createElement('p');
      p.className = 'line';
      p.textContent = s.liveLine;
      li.appendChild(p);
    }

    if (s.pending && s.pending.kind === 'grant' && s.pending.summary) {
      const c = document.createElement('p');
      c.className = 'cmd';
      c.textContent = s.pending.summary;
      li.appendChild(c);
    }

    if (s.pending && s.pending.kind === 'choice') {
      const c = document.createElement('p');
      c.className = 'cmd';
      c.textContent = `${s.pending.question || '待选'} — ${(s.pending.options || []).join(' / ')}`;
      li.appendChild(c);
    }

    const meta = document.createElement('p');
    meta.className = 'meta';
    const dur = fmt(s.state === 'running' ? s.elapsedMs : s.heldMs);
    meta.textContent = [s.agent, s.model || null, dur, `${s.actions || 0} 动作`]
      .filter(Boolean)
      .join(' · ');
    li.appendChild(meta);

    listEl.appendChild(li);
  }
}

function fmt(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}
