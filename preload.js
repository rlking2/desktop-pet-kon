// 预加载：只暴露最小 API，渲染层不给 Node 权限
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  openContextMenu: () => ipcRenderer.send('pet:context-menu'),
  quit: () => ipcRenderer.send('pet:quit'),
  onSay: (cb) => ipcRenderer.on('pet:say', (_e, text) => cb(text)),
  onAction: (cb) => ipcRenderer.on('pet:action', (_e, name) => cb(name)),
  onDebugOverlay: (cb) => ipcRenderer.on('pet:debug-overlay', (_e, on) => cb(on)),
  onForceHit: (cb) => ipcRenderer.on('pet:pointer-hit-test', (_e, hit) => cb(hit)),

  // 鼠标穿透
  pointerHit: (hit) => ipcRenderer.send('pet:pointer-hit', { hit: !!hit }),

  // 原始输入日志（诊断"真人点击无效"用）
  diag: (events) => ipcRenderer.send('pet:diag', { events }),

  // 素材清单（帧动画）：主进程读磁盘后交给渲染层，避开 CSP 对 fetch 的限制
  getAssetManifest: () => ipcRenderer.invoke('pet:asset-manifest'),
  // 形象变了要重算穿透掩码（否则点击判定范围跟角色对不上）
  refreshMask: () => ipcRenderer.send('pet:refresh-mask'),

  // 拖动（手动实现，因为 CSS drag 区域与逐像素穿透冲突）
  getBounds: () => ipcRenderer.invoke('pet:get-bounds'),
  dragStart: (payload) => ipcRenderer.send('pet:drag-start', payload),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
});
