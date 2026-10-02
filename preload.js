// 预加载：只暴露最小 API，渲染层不给 Node 权限
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  openContextMenu: () => ipcRenderer.send('pet:context-menu'),
  quit: () => ipcRenderer.send('pet:quit'),
  onSay: (cb) => ipcRenderer.on('pet:say', (_e, text) => cb(text)),
  onAction: (cb) => ipcRenderer.on('pet:action', (_e, name) => cb(name)),
  // 「保持动作」状态回报：菜单里那一项要不要打勾，以渲染层为准（渲染层才是真状态）
  reportPose: (state) => ipcRenderer.send('pet:pose', state),
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
  // 回报素材宽高比：主进程据此算桌宠列宽度与面板态窗口宽度（竖构图素材列更窄）
  setContentRatio: (ratio) => ipcRenderer.send('pet:set-content-ratio', { ratio }),
  // 回报气泡列宽度：主进程据此给气泡留出专门的一列（不然回复会压在提问面板上）
  setBubbleWidth: (width) => ipcRenderer.send('pet:set-bubble-width', { width }),
  // 回报**实测的桌宠列宽度**：主进程据此算"三列之和"，让窗口宽度和网格严丝合缝
  setPetColumn: (width) => ipcRenderer.send('pet:set-pet-column', { width }),

  // 待办面板：展开时需要更宽的窗口（并重算穿透掩码），收起时还原
  setPanel: (open) => ipcRenderer.send('pet:set-panel', { open: !!open }),
  onPanelSide: (cb) => ipcRenderer.on('pet:panel-side', (_e, side) => cb(side)),
  // 鼠标离开整个窗口（主进程探测，穿透态下渲染层收不到事件）
  onPointerOutside: (cb) => ipcRenderer.on('pet:pointer-outside', () => cb()),
  focusWindow: () => ipcRenderer.send('pet:focus-window'),

  // ---------- 第 32 轮：她的话（动作类台词可走模型 + 空闲开口 + 静音） ----------
  // 渲染层只问"这一刻该说哪句"，**判定全在主进程**（走模型还是念本地、限频、静音时段）。
  // 所以这里没有"读配置"的通道，也没有"直接调用模型"的通道 —— 渲染层碰不到密钥、也花不了 token。
  actionLine: (payload) => ipcRenderer.invoke('pet:action-line', payload),
  localLines: () => ipcRenderer.invoke('pet:action-line-lines'),
  // 设置窗口"看看现在的提示词"：只回提示词文本，不含密钥
  debugPrompt: (payload) => ipcRenderer.invoke('pet:debug-prompt', payload),
  // 主人理了她（点击/拖动）：让主进程把"空闲计时"归零，免得刚互动完她就主动开口
  userActive: (reason) => ipcRenderer.send('pet:user-active', { reason }),
  muteGet: () => ipcRenderer.invoke('pet:mute-get'),
  toggleMute: (payload) => ipcRenderer.send('pet:toggle-mute', payload),
  onMuteChanged: (cb) => ipcRenderer.on('pet:mute-changed', (_e, muted) => cb(muted)),

  // 拖动（手动实现，因为 CSS drag 区域与逐像素穿透冲突）
  getBounds: () => ipcRenderer.invoke('pet:get-bounds'),
  dragStart: (payload) => ipcRenderer.send('pet:drag-start', payload),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),

  // 兜底：鼠标此刻到底在哪（屏幕坐标 + 窗口边界）。
  // 「靠近→离开」的动作复原原来只依赖窗口自己的 mousemove，
  // 但窗口进入穿透态（setIgnoreMouseEvents）后有可能收不到后续事件 →
  // 人物就卡在「靠近」的最后一帧。渲染层用这个自己再判一次（见 renderer.js 的兜底心跳）。
  getCursor: () => ipcRenderer.invoke('pet:get-cursor'),

  // ---------- API 接入（第 25 轮） ----------
  // ★ 注意这里**没有"读取密钥"的通道**：设置窗口只能写入（apiConfigSave），
  //   主进程回给界面的永远是 lib/api-config.js 的 publicView()（只有 hasKey / 掩码）。
  //   桌宠窗口和设置窗口共用这一份 preload，所以两个界面都拿不到真实密钥。
  apiConfigGet: () => ipcRenderer.invoke('pet:api-config-get'),
  apiConfigSave: (patch) => ipcRenderer.invoke('pet:api-config-save', patch),
  apiPresets: () => ipcRenderer.invoke('pet:api-presets'),
  apiTest: () => ipcRenderer.invoke('pet:api-test'),
  chatSend: (payload) => ipcRenderer.invoke('pet:chat-send', payload),
  chatState: () => ipcRenderer.invoke('pet:chat-state'),
  openConfigFile: () => ipcRenderer.invoke('pet:open-config-file'),
  openSettings: () => ipcRenderer.send('pet:open-settings', { source: 'renderer' }),
});
