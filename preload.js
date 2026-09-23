// 预加载：只暴露最小 API，渲染层不给 Node 权限
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  openContextMenu: () => ipcRenderer.send('pet:context-menu'),
  quit: () => ipcRenderer.send('pet:quit'),
  onSay: (cb) => ipcRenderer.on('pet:say', (_e, text) => cb(text)),
  onAction: (cb) => ipcRenderer.on('pet:action', (_e, name) => cb(name)),
  onDebugOverlay: (cb) => ipcRenderer.on('pet:debug-overlay', (_e, on) => cb(on)),
});
