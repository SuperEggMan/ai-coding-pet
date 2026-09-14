'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const params = new URLSearchParams(location.search);
const sessionId = params.get('session') || '';

contextBridge.exposeInMainWorld('pet', {
  sessionId,

  /* ---------- 状态 ---------- */

  /** 主进程推来的 session 快照（每秒一次，含运行时长） */
  onState(cb) {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('pet:state', h);
    return () => ipcRenderer.removeListener('pet:state', h);
  },

  /** 阅读流增量：assistant 正文 / 思考 / 工具调用 / 工具结果 */
  onTranscript(cb) {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('pet:transcript', h);
    return () => ipcRenderer.removeListener('pet:transcript', h);
  },

  /** 皮肤包（分层 SVG / 帧序列 / 3D 的清单与文案） */
  loadSkin() {
    return ipcRenderer.invoke('pet:load-skin');
  },

  /** renderer 起来了，要一份当前状态与已有的阅读流尾部 */
  ready() {
    ipcRenderer.send('pet:ready', sessionId);
  },

  /* ---------- 视图 ---------- */

  /** 指针是否压在实体上 —— 决定整窗要不要穿透 */
  setInteractive(interactive) {
    ipcRenderer.send('pet:interactive', { sessionId, interactive });
  },

  /** 点宠物：折叠 → 状态卡 → 会话面板 → 折叠 */
  cycleView() {
    ipcRenderer.send('pet:cycle-view', { sessionId });
  },

  /** 直接指定档位 */
  setView(view) {
    ipcRenderer.send('pet:set-view', { sessionId, view });
  },

  /* ---------- 交互（桌宠当主界面的核心） ---------- */

  /** 在桌宠里打字发给 agent */
  send(text) {
    ipcRenderer.send('pet:send', { sessionId, text });
  },

  /** 打断当前这轮 */
  interrupt() {
    ipcRenderer.send('pet:interrupt', { sessionId });
  },

  /** 准奏 allow / 永准 always / 驳回 deny */
  decide(decision) {
    ipcRenderer.send('pet:decide', { sessionId, decision });
  },

  /** 请择落子 */
  choose(index) {
    ipcRenderer.send('pet:choose', { sessionId, index });
  },

  /** 切权限模式：default / acceptEdits / plan / bypassPermissions */
  setPermissionMode(mode) {
    ipcRenderer.send('pet:permission-mode', { sessionId, mode });
  },

  /** 只能看的会话:跳到 kiro/cursor 里去说话 */
  reveal() {
    ipcRenderer.send('pet:reveal', { sessionId });
  },

  /** 结束会话:真的关掉(有内核的连 agent 一起关),不可恢复 */
  endSession() {
    ipcRenderer.send('pet:end-session', { sessionId });
  },

  /** 看过了，收掉 */
  acknowledge() {
    ipcRenderer.send('pet:ack', { sessionId });
  },

  /* ---------- 拖动 / 收回宝盒 ---------- */
  getPos: () => ipcRenderer.invoke('pet:get-position', sessionId),
  setPos: (x, y) => ipcRenderer.send('pet:set-position', { sessionId, x, y }),
  getHubZone: () => ipcRenderer.invoke('pet:hub-zone'),
  dock: () => ipcRenderer.send('pet:dock', { sessionId }),

  log(...args) {
    ipcRenderer.send('pet:log', { sessionId, args });
  },
});
