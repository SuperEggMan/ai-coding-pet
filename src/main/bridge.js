'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { HOME } = require('./server');

const DEFAULT_PORT = 47801;
const TOKEN_FILE = path.join(HOME, 'mobile-token');
const STATIC_DIR = path.join(__dirname, '..', '..', 'mobile');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/**
 * 手机端桥（文档结论 6 的地基）。
 *
 * 当前只做单向：局域网内广播 session 状态，手机上看得到但动不了机器。
 * 「按住 pet 说话」「喊名字执行」需要反向下发指令，那是要能代表你操作 agent 的权限，
 * 在没有把鉴权做扎实之前不开这个口子。这里先把传输层、配对与 token 轮换铺好，
 * 反向通道的协议位留在 handleInbound()。
 */
class MobileBridge {
  constructor({ store, port = DEFAULT_PORT }) {
    this.store = store;
    this.port = port;
    this.token = readOrCreateToken();
    this.server = null;
    this.wss = null;
    this.url = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.clients = new Set();
  }

  async listen() {
    this.server = http.createServer((req, res) => this._static(req, res));

    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws' || url.searchParams.get('t') !== this.token) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.clients.add(ws);
        ws.on('close', () => this.clients.delete(ws));
        ws.on('message', (data) => this.handleInbound(ws, data));
        ws.send(JSON.stringify({ type: 'snapshot', sessions: this.store.snapshot() }));
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      // 绑 0.0.0.0 才能手机访问；靠 token 而不是靠只监听回环来控访问
      this.server.listen(this.port, '0.0.0.0', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });

    const ip = lanAddress();
    this.url = `http://${ip}:${this.port}/?t=${this.token}`;
    return { url: this.url, ip, port: this.port, token: this.token };
  }

  /** 反向通道预留位。现在一律拒绝，避免出现「看着像能用其实没鉴权」的半成品。 */
  handleInbound(ws, data) {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    ws.send(
      JSON.stringify({
        type: 'rejected',
        reason: 'inbound_control_not_enabled',
        got: msg && msg.type,
      })
    );
  }

  push() {
    if (!this.clients.size) return;
    const payload = JSON.stringify({ type: 'snapshot', sessions: this.store.snapshot() });
    for (const ws of this.clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  /** 换 token：手机丢了或分享出去了，一键作废旧配对。 */
  rotateToken() {
    this.token = crypto.randomBytes(16).toString('hex');
    fs.writeFileSync(TOKEN_FILE, this.token, { mode: 0o600 });
    for (const ws of this.clients) ws.close(4001, 'token_rotated');
    this.clients.clear();
    const ip = lanAddress();
    this.url = `http://${ip}:${this.port}/?t=${this.token}`;
    return this.url;
  }

  async close() {
    for (const ws of this.clients) ws.terminate();
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  _static(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/snapshot') {
      if (url.searchParams.get('t') !== this.token) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ sessions: this.store.snapshot() }));
      return;
    }

    let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    // 挡目录穿越：解析后必须还在 STATIC_DIR 里面
    const target = path.resolve(STATIC_DIR, rel);
    if (!target.startsWith(path.resolve(STATIC_DIR) + path.sep) && target !== path.resolve(STATIC_DIR, 'index.html')) {
      res.writeHead(403).end();
      return;
    }

    fs.readFile(target, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
      res.end(buf);
    });
  }
}

function readOrCreateToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {
    /* 首次运行没有这个文件，下面生成 */
  }
  const t = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  return t;
}

function lanAddress() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

module.exports = { MobileBridge, DEFAULT_PORT, TOKEN_FILE };
