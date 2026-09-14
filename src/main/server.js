'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_PORT = 47800;
const HOME = path.join(os.homedir(), '.ai-coding-pet');
const PORT_FILE = path.join(HOME, 'port');

/**
 * 本地状态入口。
 *
 * 为什么用 HTTP 而不是「hook 写文件 + 主进程 watch」：
 * 等授权 / 等选择必须让 hook **阻塞住**，等人在宠物上按了准奏或驳回再放行。
 * 文件轮询只能单向通报，做不到把决定回灌给 hook。
 *
 * 安全默认值：超时或本进程挂掉 → 一律回 defer，让 agent 自己的终端提示照常弹出。
 * 绝不因为 UI 不可用就自动放行，也不自动拒绝。
 */
class PetServer extends EventEmitter {
  constructor({ port = DEFAULT_PORT, permissionTimeoutMs = 10 * 60 * 1000 } = {}) {
    super();
    this.port = port;
    this.permissionTimeoutMs = permissionTimeoutMs;
    /** requestId -> {resolve, timer, sessionId} */
    this.pending = new Map();
    this.server = null;
    this.actualPort = null;
  }

  async listen() {
    this.server = http.createServer((req, res) => this._route(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      // 只绑 127.0.0.1：hook 通道不对局域网开放，手机端走独立的 bridge
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.actualPort = this.server.address().port;
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(PORT_FILE, String(this.actualPort), 'utf8');
    return this.actualPort;
  }

  async close() {
    // 先把所有阻塞中的请求放回终端，别让 agent 卡死在我们身上
    for (const [id] of this.pending) this.resolvePermission(id, 'defer', 'pet-shutdown');
    if (this.server) await new Promise((r) => this.server.close(r));
    try {
      fs.unlinkSync(PORT_FILE);
    } catch {
      /* 文件可能已被清掉，忽略 */
    }
  }

  _route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (code, body) => {
      const payload = JSON.stringify(body ?? {});
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(payload);
    };

    if (req.method === 'GET' && url.pathname === '/health') {
      return send(200, { ok: true, pid: process.pid, port: this.actualPort });
    }

    if (req.method === 'GET' && url.pathname === '/snapshot') {
      return send(200, { sessions: this.emitSnapshot() });
    }

    // 排障用：窗口真实 bounds / 可见性，以及直接抓渲染层自己画出来的内容。
    // macOS 的 screencapture 抓不到高层级窗口时，这是唯一可信的视觉验证途径。
    if (req.method === 'GET' && url.pathname === '/debug') {
      if (!this._debugFn) return send(501, { error: 'debug_source_not_set' });
      return Promise.resolve(this._debugFn(url.searchParams))
        .then((v) => send(200, v))
        .catch((e) => send(500, { error: String(e && e.message) }));
    }

    if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });

    readJson(req)
      .then((body) => {
        switch (url.pathname) {
          case '/event':
            this.emit('event', body);
            return send(200, {});

          // 切换某个会话的展开档位。给 demo 与排障用
          case '/view': {
            if (!body.session_id) return send(400, { error: 'missing_session_id' });
            this.emit('view', { sessionId: body.session_id, view: body.view || 'card' });
            return send(200, {});
          }

          // 注入阅读流条目。给 demo 与排障用：不需要真实 Claude 凭据也能验证会话面板
          case '/transcript': {
            const items = Array.isArray(body.items) ? body.items : [];
            if (!body.session_id || !items.length) return send(400, { error: 'bad_payload' });
            this.emit('transcript', { sessionId: body.session_id, items });
            return send(200, { accepted: items.length });
          }

          case '/permission':
            return this._handlePermission(body, send);

          case '/decision': {
            const { request_id: rid, decision, note } = body || {};
            const ok = this.resolvePermission(rid, decision, note || 'remote');
            return send(ok ? 200 : 404, { ok });
          }

          // 排障用：强制给某个窗口一次真正的焦点/激活，排查"accessory 应用
          // 从不被激活,导致首次真实点击进不来"这个猜想。
          case '/debug-focus': {
            const { session_id: fsid } = body || {};
            if (!fsid) return send(400, { error: 'bad_payload' });
            this.emit('debug-focus', { sessionId: fsid });
            return send(200, {});
          }

          // 排障用：把某个窗口直接挪到指定屏幕坐标，排查"这块屏幕位置是否
          // 被别的常驻置顶窗口占着"。
          case '/debug-move': {
            const { session_id: msid, x: mx, y: my } = body || {};
            if (!msid || typeof mx !== 'number' || typeof my !== 'number') {
              return send(400, { error: 'bad_payload' });
            }
            this.emit('debug-move', { sessionId: msid, x: mx, y: my });
            return send(200, {});
          }

          // 排障用：直接在某个窗口的渲染层里模拟一次真实鼠标点击(窗口内坐标)。
          // 不走 macOS 辅助功能权限,只是 Electron 自己的输入事件管线，
          // 用来验证"点击到底有没有落到该落的 DOM 元素上"。
          case '/debug-click': {
            const { session_id: sid, x, y, double } = body || {};
            if (!sid || typeof x !== 'number' || typeof y !== 'number') {
              return send(400, { error: 'bad_payload' });
            }
            this.emit('debug-click', { sessionId: sid, x, y, double: Boolean(double) });
            return send(200, {});
          }

          default:
            return send(404, { error: 'not_found' });
        }
      })
      .catch((err) => send(400, { error: 'bad_request', detail: String(err && err.message) }));
  }

  /**
   * hook 调这里并挂住，直到有人决定或超时。
   *
   * 挂住之前先过一道**闸门**（由 main 注入，见 setGrantPolicy）：
   * 请奏挂在 PreToolUse 上、是同步阻塞的，如果每次工具调用都弹到宠物身上等人，
   * kiro 会变得没法用。所以闸门负责把「不值得打扰人」的那些直接放行，
   * 只有真危险的才落到下面阻塞等人。
   */
  _handlePermission(body, send) {
    const requestId = body.request_id || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sessionId = body.session_id;
    if (!sessionId) return send(400, { error: 'missing_session_id' });

    if (this._grantPolicy) {
      let verdict = null;
      try {
        verdict = this._grantPolicy(body);
      } catch (err) {
        // 闸门自己出错不能把 agent 卡住：当没这道门，继续走阻塞审批
        verdict = null;
      }
      if (verdict && verdict.decision && verdict.decision !== 'ask') {
        return send(200, { decision: verdict.decision, note: verdict.note || 'gate', request_id: requestId });
      }
    }

    this.emit('event', { ...body, request_id: requestId, kind: 'permission_request' });

    const timer = setTimeout(() => {
      this.resolvePermission(requestId, 'defer', 'timeout');
    }, this.permissionTimeoutMs);
    if (timer.unref) timer.unref();

    this.pending.set(requestId, {
      sessionId,
      timer,
      // 原始请求留一份：落「永准」时需要知道这是哪个工具，光有 requestId 不够
      body,
      resolve: (decision, note) => {
        send(200, { decision, note, request_id: requestId });
      },
    });
  }

  /**
   * 落决定。decision 取 allow / always / deny / defer。
   * defer = 我们不表态，交回 agent 自己的终端流程。
   */
  resolvePermission(requestId, decision, note) {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const safe = ['allow', 'always', 'deny', 'defer'].includes(decision) ? decision : 'defer';
    try {
      entry.resolve(safe, note);
    } catch {
      /* 连接可能已被 hook 端断开（人在终端里先答了），忽略 */
    }
    this.emit('event', { session_id: entry.sessionId, kind: 'resolved', decision: safe });
    // 带上原始请求的一路：main 侧据此记住「这个工具以后不用再问」
    this.emit('decided', { requestId, decision: safe, note, body: entry.body || {} });
    return true;
  }

  /** 由 main.js 注入，用来给 /snapshot 供数。 */
  emitSnapshot() {
    return this._snapshotFn ? this._snapshotFn() : [];
  }

  setSnapshotSource(fn) {
    this._snapshotFn = fn;
  }

  /**
   * 注入请奏闸门。
   *
   * @param {(body: object) => ({decision?: string, note?: string}|null)} fn
   *   返回 `{decision:'allow'}` 之类 = 立刻放行/拒绝，不打扰人；
   *   返回 `null` 或 `{decision:'ask'}` = 落到阻塞审批，等人在宠物上按。
   *   判据放在 main 而不是这里，是因为它要用 states.js 的危险度判定和用户偏好，
   *   server 只管通道、不管策略。
   */
  setGrantPolicy(fn) {
    this._grantPolicy = fn;
  }

  setDebugSource(fn) {
    this._debugFn = fn;
  }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    // 攒 Buffer 数组，最后一次性 concat 再转 utf8 —— 不能 `raw += chunk`
    // (每个 chunk 各自按 toString() 转码):一个多字节 UTF-8 字符(中文都是
    // 3 字节)如果恰好被 TCP 分片切在两个 chunk 之间，各自转码会各自出现
    // 替换字符/乱码。kiro hook 上报的中文标题/命令/输出全走这条路，body
    // 不小，踩中分片的概率不低——这是之前"抓取的 kiro 内容都乱码了"的根因。
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = { PetServer, DEFAULT_PORT, HOME, PORT_FILE };
