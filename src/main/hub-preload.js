'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  /** 开新活选项:默认目录 + 历史目录 + 当前客户端 */
  options: () => ipcRenderer.invoke('hub:options'),
  /** 切换开工客户端(kiro/claude/codex/cursor) */
  setClient: (client) => ipcRenderer.invoke('hub:set-client', client),
  /** 直接在某个目录开工(默认目录 / 历史目录点选) */
  openDir: (dir) => ipcRenderer.invoke('hub:open-dir', dir),
  /** 打开系统目录选择框 → 起一个新会话。返回是否成功。 */
  pickFolder: () => ipcRenderer.invoke('hub:pick-folder'),
  /** 双击云糯:在 <base>/<yyyyMMdd>/<序号> 建一块新地方再开会话 */
  quickNew: () => ipcRenderer.invoke('hub:quick-new'),
  /** 结束某个会话(会话真的没了,不是收起来) */
  endSession: (sessionId) => ipcRenderer.invoke('hub:end-session', sessionId),
  /** 把目录从「最近目录」划掉,不动磁盘 */
  forgetDir: (dir) => ipcRenderer.invoke('hub:forget-dir', dir),
  /** 删掉一个临时工作目录(移到废纸篓,可捞回) */
  trashDir: (dir) => ipcRenderer.invoke('hub:trash-dir', dir),
  /** 在世的会话清单(含是否已收进宝盒) */
  sessions: () => ipcRenderer.invoke('hub:sessions'),
  /** 把某个会话的宠物放回桌面 */
  recall: (sessionId) => ipcRenderer.invoke('hub:recall', sessionId),
  /** 有宠物钻回窝里 —— 云糯脚下冒一小朵云接住 */
  onPuff(cb) {
    ipcRenderer.on('hub:puff', () => cb());
  },
  /** 会话增删 / 收起 / 放回时的通知,菜单开着就重画「历史会话」 */
  onSessionsChanged(cb) {
    ipcRenderer.on('hub:sessions-changed', () => cb());
  },
  /** 指针是否压在云糯/菜单上 —— 决定窗口要不要点穿到下层 */
  setInteractive(interactive) {
    ipcRenderer.send('hub:interactive', { interactive });
  },
  /** 把宝盒藏起来(托盘可再召唤) */
  hide: () => ipcRenderer.send('hub:hide'),
  /** 菜单开合 → 窗口在「只裹云糯」和「摊开菜单」两档之间缩放 */
  menu: (open) => ipcRenderer.invoke('hub:menu', open),
  /** 拖拽云糯:读当前窗口位置 / 按绝对坐标放 */
  getPos: () => ipcRenderer.invoke('hub:get-position'),
  setPos: (x, y) => ipcRenderer.send('hub:set-position', { x, y }),
});
