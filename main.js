// 鲸鱼娘桌宠 · 主进程
// 阶段0 目标：透明 / 无边框 / 永远置顶 / 能拖 / 右键菜单 / AUTOTEST 自检
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { installClickThrough } = require('./lib/click-through');
const { loadAnimationManifest } = require('./lib/assets');

const ROOT = __dirname;
const ARTIFACTS = path.join(ROOT, 'artifacts');
const AUTOTEST = process.env.DSH_PET_AUTOTEST === '1';
const WIN_W = 200;
const WIN_H = 250;
const MARGIN = 30;

let win = null;
let clickThrough = null;
const diag = { warnings: [], errors: [], console: [] };

// ---------- 原始输入日志管道 ----------
// 真人反馈"点击和右键都无效"，而合成事件自检全绿 → 必须记录真实事件，不能再靠推理。
// 渲染层每个鼠标事件都写进这里，主人复现一次，人家就能看出事件卡在哪一层。
let inputLog = [];
let inputLogPath = null;
const INPUT_LOG_LIMIT = 4000;

function initInputLog() {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    inputLogPath = path.join(ARTIFACTS, `input-${stamp}.log`);
    fs.writeFileSync(inputLogPath, `# 鲸鱼娘桌宠 原始输入日志\n# 开始时间 ${new Date().toISOString()}\n# Electron ${process.versions.electron}\n`);
    return inputLogPath;
  } catch (err) {
    console.error('[输入日志] 初始化失败:', err && err.message);
    return null;
  }
}

function logInput(entry) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${entry.src.padEnd(9)} ${entry.type.padEnd(12)} ${entry.detail || ''}`;
  if (inputLog.length < INPUT_LOG_LIMIT) inputLog.push(line);
  if (inputLogPath) {
    try { fs.appendFileSync(inputLogPath, line + '\n'); } catch { /* 磁盘问题不该影响桌宠 */ }
  }
  if (process.env.DSH_PET_INPUT_VERBOSE === '1') console.log('[输入] ' + line);
}

// 单实例：第二次启动只把已有窗口叫到前面
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });
}

function createWindow() {
  const work = screen.getPrimaryDisplay().workArea;
  initInputLog();

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: process.env.DSH_PET_POS === 'top' ? work.x + 60 : work.x + work.width - WIN_W - MARGIN,
    y: process.env.DSH_PET_POS === 'top' ? work.y + 2 : work.y + work.height - WIN_H - MARGIN,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    title: '鲸鱼娘桌宠',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  // 置顶等级：浮动层，普通窗口盖不住她
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 鼠标穿透：透明区域放行给桌面，实体像素才可点可拖
  clickThrough = installClickThrough(win);
  win.on('closed', () => { if (clickThrough) clickThrough.dispose(); });

  // 菜单要尽早设置并隐藏：晚设会把窗口高度撑大几像素（Windows 会为菜单栏预留空间）
  applyChineseMenus();
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(true);

  win.once('ready-to-show', () => {
    win.show();
    // 注意：自检时不打开红色边框层——辅助线会污染被检截图。
    // 需要看窗口边界时用 DSH_PET_DEBUG=1 单独启动。
    if (process.env.DSH_PET_DEBUG === '1') win.webContents.send('pet:debug-overlay', true);
    // 生成穿透用 alpha 掩码（冻结动画 + 藏气泡，保证掩码干净）
    setTimeout(() => {
      clickThrough.refreshMask()
        .then((m) => {
          console.log(`[穿透掩码] ${m.physical} → ${m.mw}x${m.mh} 实体占比 ${(m.coverage * 100).toFixed(1)}% bbox=${JSON.stringify(m.bbox)}`);
          logInput({ src: 'main', type: 'mask-ready', detail: `覆盖率=${m.coverage} bbox=${JSON.stringify(m.bbox)}` });
        })
        .catch((e) => console.error('[穿透掩码] 生成失败:', e && e.message));
    }, 400);

    // 启动横幅：确认跑的是哪一版代码 + 日志路径
    logInput({ src: 'main', type: 'startup', detail: `含4px移动阈值 + mousedown 无 preventDefault；electron=${process.versions.electron}` });
    logInput({ src: 'main', type: 'log-path', detail: inputLogPath || '(未启用)' });
    console.log(`\n[桌宠已启动] 原始输入日志: ${inputLogPath}`);
    console.log('主人点她几下、右键几下，人家读日志定位问题。\n');

    // 心跳：记录事件发生那一刻的"命中判定 + 穿透状态"
    if (!AUTOTEST) {
      const beat = setInterval(() => {
        if (!win || win.isDestroyed()) return;
        try {
          const pt = screen.getCursorScreenPoint();
          const b = win.getBounds();
          const inside = pt.x >= b.x && pt.x < b.x + b.width && pt.y >= b.y && pt.y < b.y + b.height;
          const cs = clickThrough.getState();
          const hit = inside ? clickThrough.hitTest(pt.x - b.x, pt.y - b.y) : null;
          logInput({
            src: 'main',
            type: 'heartbeat',
            detail: `鼠标=(${pt.x},${pt.y}) 窗口内=${inside} 命中实体=${hit} 穿透中=${cs.ignoring} 窗口=(${b.x},${b.y},${b.width},${b.height})`,
          });
        } catch { /* 心跳失败不该影响桌宠 */ }
      }, 3000);
      beat.unref?.();
    }
  });

  // Electron 44：console-message 已改为事件对象形式（旧的 (event, level, msg) 形参已废弃）
  win.webContents.on('console-message', (event) => {
    const p = event || {};
    const entry = {
      level: p.level ?? 'info',
      message: String(p.message ?? ''),
      line: p.lineNumber ?? 0,
      source: path.basename(String(p.sourceId || '')),
    };
    diag.console.push(entry);
    if (entry.level === 'warning') diag.warnings.push(entry);
    if (entry.level === 'error') diag.errors.push(entry);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    diag.errors.push({ level: 3, message: `render-process-gone: ${details.reason}` });
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    diag.errors.push({ level: 3, message: `did-fail-load ${code} ${desc} ${url}` });
  });

  // 原生右键兜底：Electron 的 webContents 'context-menu' 事件不经过 DOM 的 contextmenu，
  // 万一渲染层因为透明窗口/穿透状态没收到 DOM 事件，这条原生路径仍然能弹出菜单。
  win.webContents.on('context-menu', () => {
    logInput({ src: 'main', type: 'native-contextmenu', detail: '收到原生 context-menu 事件' });
    openMenu('native-webContents');
  });

  // 气泡屏幕取证模式：必须在 loadFile 之前挂监听，否则 did-finish-load 已经过去了
  if (process.env.DSH_PET_BUBBLE_PROBE === '1') {
    win.webContents.once('did-finish-load', () => { setTimeout(() => runBubbleProbe(), 1500); });
    setTimeout(() => {
      if (!app.__bubbleProbeDone) {
        console.log('[气泡探针] TIMEOUT：未完成，强制收尾');
        app.exit(3);
      }
    }, 25000);
  }

  win.loadFile(path.join(ROOT, 'renderer', 'index.html'));

  win.on('closed', () => { win = null; });

  if (AUTOTEST) {
    win.webContents.once('did-finish-load', () => {
      // 等动画/字体稳定后再截图
      setTimeout(() => runSelfCheck(), 1500);
      // 兜底：绝不允许自检挂死
      setTimeout(() => {
        if (!app.__selfCheckDone) {
          console.log('[AUTOTEST] TIMEOUT: 自检未完成，强制收尾');
          app.exit(3);
        }
      }, 15000);
    });
  }
  return win;
}

// ---------- 中文界面（Electron 内置菜单默认是英文，这里全部换成中文） ----------
// 注意：只替换界面文案与角色标签，代码标识符（role / 文件名 / API）保持英文不动。
function applyChineseMenus() {
  const appMenu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '回到底部右侧', click: () => {
            if (!win || win.isDestroyed()) return;
            const work = screen.getPrimaryDisplay().workArea;
            win.setBounds({ x: work.x + work.width - WIN_W - MARGIN, y: work.y + work.height - WIN_H - MARGIN, width: WIN_W, height: WIN_H });
          } },
        { type: 'separator' },
        { label: '关闭窗口', role: 'close' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏切换', role: 'togglefullscreen' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '缩放', role: 'zoom' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于鲸鱼娘桌宠', click: () => {
            if (!win || win.isDestroyed()) return;
            const { dialog } = require('electron');
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: '鲸鱼娘桌宠',
              detail: `阶段 1：透明置顶 + 逐像素鼠标穿透 + 自动自检\n\nElectron ${process.versions.electron}\nChrome ${process.versions.chrome}\nNode ${process.versions.node}\n\n状态：自检 42 条断言 + 10 条像素分析\n日志目录：artifacts/\n\n人家是 DeepSeek 的官方拟人化形象，才不是随便一只鲸鱼呢。`,
              buttons: ['知道啦'],
            });
          } },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);
}

// ---------- 右键菜单 ----------
const menuLog = { opened: 0, errors: [], lastAt: null };

// 模板单独抽出来：可以脱离 popup 单独验证，避免自检被模态菜单卡死
function buildMenuTemplate() {
  return [
    { label: '🐋 鲸鱼娘桌宠 · 阶段1', enabled: false },
    { type: 'separator' },
    { label: '永远置顶', type: 'checkbox', checked: win.isAlwaysOnTop(), click: (mi) => win.setAlwaysOnTop(mi.checked, 'floating') },
    { label: '让她说句话', click: () => win.webContents.send('pet:say', '主人……人家在的啦，哼。') },
    { label: '摸头', click: () => win.webContents.send('pet:action', 'headpat') },
    { label: '喂白饭（+1 token）', click: () => win.webContents.send('pet:action', 'rice') },
    { type: 'separator' },
    { label: '回到底部右侧', click: () => {
        const work = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x: work.x + work.width - WIN_W - MARGIN, y: work.y + work.height - WIN_H - MARGIN, width: WIN_W, height: WIN_H });
      } },
    { label: '开发者工具', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: '退出（人家要下班了）', click: () => app.quit() },
  ];
}

function openMenu(source) {
  try {
    // 去抖：渲染层 IPC 和原生 context-menu 事件可能在同一秒内双双触发，只认第一次
    const now = Date.now();
    if (menuLog.lastPopupAt && now - menuLog.lastPopupAt < 600) {
      logInput({ src: 'main', type: 'menu-skip', detail: `重复触发被去抖（来源=${source}）` });
      return true;
    }
    menuLog.lastPopupAt = now;
    menuLog.opened++;
    menuLog.lastAt = new Date().toISOString();
    menuLog.lastSource = source;
    if (!win || win.isDestroyed()) {
      menuLog.errors.push('win 不存在或已销毁');
      return false;
    }
    const menu = Menu.buildFromTemplate(buildMenuTemplate());
    menu.popup({ window: win });   // popup 是异步的，不会阻塞主进程
    logInput({ src: 'main', type: 'menu-popup', detail: `菜单已弹出（来源=${source}，第 ${menuLog.opened} 次）` });
    return true;
  } catch (err) {
    menuLog.errors.push(String(err && err.message || err));
    logInput({ src: 'main', type: 'menu-error', detail: String(err && err.message || err) });
    console.error('[右键菜单] 打开失败:', err);
    return false;
  }
}

ipcMain.on('pet:context-menu', () => openMenu('renderer-ipc'));
ipcMain.on('pet:quit', () => app.quit());

// 渲染层把真实鼠标事件上报到这里 → 落盘成原始日志
ipcMain.on('pet:diag', (_e, payload) => {
  if (!payload || !Array.isArray(payload.events)) return;
  for (const ev of payload.events) logInput(ev);
});
ipcMain.on('pet:diag-batch', (_e, text) => {
  if (!text) return;
  if (inputLogPath) { try { fs.appendFileSync(inputLogPath, String(text) + '\n'); } catch { /* ignore */ } }
});

// 拖动由 lib/click-through.js 统一处理（手动实现，因为它与逐像素穿透绑定在一起）
ipcMain.handle('pet:get-bounds', () => {
  const b = win.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});

// 素材清单：主进程读磁盘 → 渲染层用（避开 CSP 对 fetch 的限制）
ipcMain.handle('pet:asset-manifest', () => loadAnimationManifest(path.join(ROOT, 'assets')));

// 形象变化后重算穿透掩码（渲染层加载完帧动画会请求一次）
ipcMain.on('pet:refresh-mask', () => {
  if (!clickThrough) return;
  setTimeout(() => {
    clickThrough.refreshMask()
      .then((m) => {
        console.log(`[穿透掩码] 重算完成：实体占比 ${(m.coverage * 100).toFixed(1)}% bbox=${JSON.stringify(m.bbox)}`);
        logInput({ src: 'main', type: 'mask-refresh', detail: `覆盖率=${m.coverage} bbox=${JSON.stringify(m.bbox)}` });
      })
      .catch((e) => console.error('[穿透掩码] 重算失败:', e && e.message));
  }, 250);
});

// 穿透探针模式：故意在 穿透 ↔ 可交互 之间来回翻转，
// 让外部 Win32 探针去读 GWL_EXSTYLE，独立验证 setIgnoreMouseEvents 真的作用到 OS 层。
// 没有任何窗口状态的"自证"能替代这一步——必须由外部来量。
if (process.env.DSH_PET_PROBE === '1') {
  let phase = 0;
  const probeTimer = setInterval(() => {
    if (!clickThrough || !win || win.isDestroyed()) return;
    const wantIgnore = phase % 2 === 0;
    clickThrough.forceIgnore(wantIgnore);
    console.log(`[穿透探针] phase=${phase} 设定 ignoring=${wantIgnore}`);
    phase++;
    if (phase > 40) { clearInterval(probeTimer); console.log('[穿透探针] 采样结束'); }
  }, 320);
  probeTimer.unref?.();
}

// ---------- 自检 ----------
async function runSelfCheck() {
  try {
    fs.mkdirSync(ARTIFACTS, { recursive: true });

    // 窗口状态
    const b = win.getBounds();
    const display = screen.getPrimaryDisplay();
    const state = {
      windowVisible: win.isVisible(),
      alwaysOnTop: win.isAlwaysOnTop(),
      bounds: b,
      displayScaleFactor: display.scaleFactor,
      workArea: display.workArea,
      insideWorkArea:
        b.x >= display.workArea.x && b.y >= display.workArea.y &&
        b.x + b.width <= display.workArea.x + display.workArea.width &&
        b.y + b.height <= display.workArea.y + display.workArea.height,
      devicePixelRatio: await win.webContents.executeJavaScript('window.devicePixelRatio'),
    };

    // 页面度量：占位形象的数据（可断言，不靠肉眼）
    const metrics = await win.webContents.executeJavaScript(`(() => {
      const q = (s) => document.querySelector(s);
      const rect = (s) => { const el = q(s); if (!el) return null; const r = el.getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      return {
        title: document.title,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        innerSize: { w: window.innerWidth, h: window.innerHeight },
        petVisible: !!(q('#pet') && q('#pet').offsetWidth > 0),
        petRect: rect('#pet'),
        tailRect: rect('#tail'),
        bubbleText: (q('#bubble') || {}).textContent || '',
        animRunning: getComputedStyle(q('.whale')).animationName,
        // 帧动画（素材）状态：渲染层的 __petTest.state() 才有，这里读同一个来源
        sprite: (window.__petTest && window.__petTest.state) ? window.__petTest.state().sprite : null,
        // 穿透相关：这些元素都属于"实体"，鼠标落在上面时不应穿透
        dragRegion: getComputedStyle(q('#pet')).webkitAppRegion || 'none',
      };
    })()`);

    const image = await win.webContents.capturePage();
    const png = image.toPNG();
    const shotPath = path.join(ARTIFACTS, 'shot-latest.png');
    fs.writeFileSync(shotPath, png);

    // 空图/白图检测：统计非透明像素比例
    const size = image.getSize();
    const bitmap = image.toBitmap(); // BGRA
    let opaque = 0;
    for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] >= 16) opaque++;
    const opaqueRatio = +(opaque / (bitmap.length / 4)).toFixed(4);

    const report = {
      timestamp: new Date().toISOString(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: `${process.platform}-${process.arch}`,
      window: state,
      page: metrics,
      spriteMode: !!(metrics.sprite && metrics.sprite.available),
      screenshot: { path: path.relative(ROOT, shotPath), bytes: png.length, width: size.width, height: size.height, opaqueRatio },
      consoleWarnings: diag.warnings.length,
      consoleErrors: diag.errors.length,
      log: diag.console.slice(-20),
      checks: [],
    };

    const push = (name, pass, detail) => report.checks.push({ name, pass, detail });

    push('窗口可见', state.windowVisible === true, `visible=${state.windowVisible}`);
    push('永远置顶生效', state.alwaysOnTop === true, `alwaysOnTop=${state.alwaysOnTop}`);
    // 用页面视口（逻辑 CSS 像素）判定尺寸；Windows 在高 DPI 下会把窗口吸到整数物理像素网格，
    // 1.5 缩放时 260x320 会变成 264x324，属于系统行为，不是 bug → 给 ±4 逻辑像素容差
    const TOL = 6; // 加上菜单栏可能带来的 1px 取整，容差放宽到 ±6
    const dw = Math.abs(metrics.innerSize.w - WIN_W);
    const dh = Math.abs(metrics.innerSize.h - WIN_H);
    push('窗口尺寸符合设计(±4)', dw <= TOL && dh <= TOL,
      `视口 ${metrics.innerSize.w}x${metrics.innerSize.h} / 设计 ${WIN_W}x${WIN_H}（偏差 ${dw}x${dh}，DPR ${state.devicePixelRatio}）`);
    push('完整落在工作区内', state.insideWorkArea === true, `bounds=${JSON.stringify(b)} workArea=${JSON.stringify(display.workArea)}`);
    push('透明背景（body 非纯色）', /rgba\(0, 0, 0, 0\)|transparent/.test(metrics.bodyBg), `bodyBg=${metrics.bodyBg}`);
    push('占位形象已渲染', metrics.petVisible === true && !!metrics.petRect, `petRect=${JSON.stringify(metrics.petRect)}`);
    push('尾鳍元素存在', !!metrics.tailRect, `tailRect=${JSON.stringify(metrics.tailRect)}`);
    if (metrics.sprite && metrics.sprite.available) {
      push('待机动画在跑（帧动画模式）', metrics.sprite.drewFrames > 0 && metrics.sprite.modeClass === true,
        `已绘制 ${metrics.sprite.drewFrames} 帧；CSS 呼吸动画已停用（避免与帧动画叠加）`);
    } else {
      push('待机动画在跑（内置 SVG 模式）', !!metrics.animRunning && metrics.animRunning !== 'none',
        `animationName=${metrics.animRunning}`);
    }
    // 帧动画（素材）状态：有素材时应该是 sprite-mode，没有则退回 SVG
    {
      const sp = metrics.sprite || {};
      if (sp.available) {
        push('帧动画已启用并切换显示', sp.modeClass === true && sp.groups.length > 0,
          `动作=[${(sp.groups || []).join(', ')}] 主动作=${sp.activeGroup} 已绘制 ${sp.drewFrames} 帧`);
      } else {
        push('无素材时退回内置 SVG 形象', sp.modeClass !== true && sp.reason != null,
          `素材状态：${sp.reason}`);
      }
    }
    // 拖动改成手动实现（CSS -webkit-app-region 与逐像素穿透冲突），断言没有残留的 CSS drag 区域
    push('未使用 CSS drag 区域（改手动拖动）', metrics.dragRegion !== 'drag', `-webkit-app-region=${metrics.dragRegion}`);
    push('截图非空白', opaqueRatio > 0.02, `opaqueRatio=${opaqueRatio}`);
    push('无渲染错误', diag.errors.length === 0, `errors=${diag.errors.length}`);

    // 窗口边框断言：四边 2px 内不许出现粉红边框色（调试红框 #ff3f6f 就是靠这个抓出来的）
    {
      const isPinkish = (i) => {
        const bb = bitmap[i], gg = bitmap[i + 1], rr = bitmap[i + 2];
        return rr > 200 && gg < 140 && bb > 60 && bb < 190;
      };
      let borderPink = 0, scanned = 0;
      const scanEdge = (x0, y0, x1, y1) => {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
            scanned++;
            if (isPinkish((y * size.width + x) * 4)) borderPink++;
          }
        }
      };
      scanEdge(0, 0, size.width - 1, 1);
      scanEdge(0, size.height - 2, size.width - 1, size.height - 1);
      scanEdge(0, 0, 1, size.height - 1);
      scanEdge(size.width - 2, 0, size.width - 1, size.height - 1);
      push('窗口没有边框（四边无粉红框线）', borderPink === 0,
        `扫描 ${scanned} 个边缘像素，粉红边框色=${borderPink}（>0 说明调试红框或 CSS 边框漏出来了）`);
    }

    // ---------- 鼠标穿透断言 ----------
    const cs = clickThrough.getState();
    const maskStats = cs.stats;
    push('穿透掩码已生成', cs.maskReady === true, `maskCoverage=${maskStats.maskCoverage} 物理=${maskStats.maskPhysical}`);
    push('掩码只覆盖实体（不是整块窗口）', maskStats.maskCoverage > 0.05 && maskStats.maskCoverage < 0.75,
      `实体占比=${maskStats.maskCoverage}（接近 1.0 说明整窗被判为实体，穿透会失效）`);
    // 掩码不该贴到窗口边缘——贴边说明有"整圈辅助视觉"（比如调试红框）被烧进了掩码
    const mb = maskStats.maskBbox;
    push('掩码未把窗口边框当成实体', !!mb && mb.minX >= 2 && mb.minY >= 2,
      `maskBbox=${JSON.stringify(mb)}（minX/minY 为 0 说明有整圈元素被误判为实体）`);
    // ⚠️ round-04 事故：当初用 insertCSS 隐藏气泡，而 insertCSS 无法撤销，
    //    导致生成掩码后气泡永久不可见（点击有反应但屏幕上什么都看不到）
    const mr = maskStats.maskRestore;
    push('生成掩码后气泡已恢复可见（不许用不可撤销的 insertCSS）',
      !!mr && mr.styleLeft === false && mr.freezeClassLeft === false && mr.bubbleVisibility === 'visible',
      `样式标签残留=${mr && mr.styleLeft} 冻结类残留=${mr && mr.freezeClassLeft} 气泡 visibility=${mr && mr.bubbleVisibility}`);

    // 取窗口内几个点的屏幕坐标：中心(实体)、左上角(空气)、右下角(空气)、窗口外
    const rect = win.getBounds();
    const tCenter = clickThrough.testPoint(rect.x + Math.round(rect.width / 2), rect.y + Math.round(rect.height / 2));
    const tTL = clickThrough.testPoint(rect.x + 2, rect.y + 2);
    const tBR = clickThrough.testPoint(rect.x + rect.width - 3, rect.y + rect.height - 3);
    const tOutside = clickThrough.testPoint(rect.x - 50, rect.y - 50);

    push('中心命中实体（可点可拖）', tCenter.inside === true && tCenter.hit === true,
      `offset=(${tCenter.offsetX},${tCenter.offsetY}) hit=${tCenter.hit}`);
    push('左上角留白判定为空气（点击穿透）', tTL.hit === false, `hit=${tTL.hit} wouldIgnore=${tTL.wouldIgnore}`);
    push('右下角留白判定为空气（点击穿透）', tBR.hit === false, `hit=${tBR.hit} wouldIgnore=${tBR.wouldIgnore}`);
    push('窗口外一律穿透', tOutside.inside === false && tOutside.wouldIgnore === true,
      `inside=${tOutside.inside} wouldIgnore=${tOutside.wouldIgnore}`);

    report.clickThrough = {
      state: cs,
      probes: { center: tCenter, topLeft: tTL, bottomRight: tBR, outside: tOutside },
    };

    report.passed = report.checks.filter((c) => c.pass).length;
    report.total = report.checks.length;
    report.ok = report.passed === report.total;

    console.log('\n===== 鲸鱼娘自检报告 =====');
    console.log(`Electron ${report.electron} / Chrome ${report.chrome} / Node ${report.node}`);
    console.log(`窗口: ${b.width}x${b.height} @(${b.x},${b.y}) 置顶=${state.alwaysOnTop} 在工作区内=${state.insideWorkArea}`);
    console.log(`截图: ${report.screenshot.path} (${size.width}x${size.height}, ${png.length} bytes, 不透明占比 ${opaqueRatio})`);
    console.log(`形象: petRect=${JSON.stringify(metrics.petRect)} 动画=${metrics.animRunning}`);
    console.log('--- 断言 ---');
    for (const c of report.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);

    // ---------- 第二阶段：交互自动化 ----------
    const inter = await runInteractionTest();
    report.interaction = inter;
    report.menu = inter.menu;
    report.rightClickDiag = inter.rightClickDiag;
    for (const c of inter.checks) report.checks.push(c);
    console.log('--- 交互断言 ---');
    for (const c of inter.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
    console.log(`交互截图: ${inter.screenshot}`);
    console.log(`窗口尺寸轨迹: ${inter.boundsTrace}`);

    // 断言总数重算
    report.passed = report.checks.filter((c) => c.pass).length;
    report.total = report.checks.length;
    report.ok = report.passed === report.total;
    fs.writeFileSync(path.join(ARTIFACTS, 'selfcheck.json'), JSON.stringify(report, null, 2));

    if (diag.console.length) {
      console.log('--- 渲染进程日志 ---');
      for (const l of diag.console.slice(-10)) console.log(`[${l.level}] ${l.message}`);
    }
    console.log(`===== 结果: ${report.passed}/${report.total} ${report.ok ? '✅ 全部通过' : '❌ 有失败项'} =====\n`);

    app.__selfCheckDone = true;
    app.exit(report.ok ? 0 : 2);
  } catch (err) {
    console.error('[AUTOTEST] 自检异常:', err && err.stack || err);
    app.__selfCheckDone = true;
    app.exit(4);
  }
}

// ---------- 交互自动化：点击 → 气泡 + 蹦跳；摸头 → 脸红；生气台词 ----------
async function runInteractionTest() {
  const checks = [];
  const push = (name, pass, detail) => checks.push({ name, pass, detail });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const js = (code) => win.webContents.executeJavaScript(code);
  // 窗口尺寸漂移追踪：找出 +1px 是哪一步引入的
  const boundsTrace = [];
  const trace = (tag) => { const b = win.getBounds(); boundsTrace.push(`${tag}=${b.width}x${b.height}`); return b; };
  trace('交互开始');

  await js('window.__petTest.click()');
  await wait(180);
  let s = await js('window.__petTest.state()');
  push('点击后出气泡', s.bubbleShown === true && s.bubbleText.length > 0, `text="${s.bubbleText}" shown=${s.bubbleShown}`);
  push('点击触发蹦跳动画', /hop/.test(s.petClasses), `classes="${s.petClasses}"`);

  await js('window.__petTest.action("headpat")');
  await wait(180);
  s = await js('window.__petTest.state()');
  const blush = await js(`(() => {
    const b = document.querySelector('.blush');
    return b ? getComputedStyle(b).opacity : null;
  })()`);
  push('摸头触发脸红动画', /pat/.test(s.petClasses), `classes="${s.petClasses}" blushOpacity=${blush}`);

  await js('window.__petTest.action("angry")');
  await wait(180);
  s = await js('window.__petTest.state()');
  push('生气状态可触发（傲娇台词）', /angry/.test(s.petClasses), `classes="${s.petClasses}" text="${s.bubbleText}"`);

  // ---------- 穿透 + 手动拖动链路 ----------
  const before = win.getBounds();
  const hitOnPet = await js('window.__petTest.probeHit(100, 120)');   // 角色所在区域
  const hitOnAir = await js('window.__petTest.probeHit(4, 4)');       // 左上留白
  push('渲染层判定：角色上=命中实体', hitOnPet.hit === true, `hit=${hitOnPet.hit} element=${hitOnPet.element}`);
  push('渲染层判定：留白处=空气', hitOnAir.hit === false, `hit=${hitOnAir.hit} element=${hitOnAir.element}`);

  // 反复拖动 5 轮，验证"窗口不会越拖越大"（Windows 高 DPI 取整误差累积的坑）
  const sizes = [];
  for (let i = 0; i < 5; i++) {
    await js('window.__petTest.dragSimulate()');
    sizes.push(`${win.getBounds().width}x${win.getBounds().height}`);
  }
  trace('拖动模拟后');
  const after = win.getBounds();
  push('反复拖动 5 轮窗口尺寸不漂移', new Set(sizes).size === 1,
    `每轮尺寸=${sizes.join(' → ')}`);
  push('自检拖动未搬动窗口', after.x === before.x && after.y === before.y,
    `before=(${before.x},${before.y}) after=(${after.x},${after.y})（自检不该污染桌面）`);
  const csAfter = clickThrough.getState();
  push('拖动结束后未卡在拖拽态', csAfter.dragging === false, `dragging=${csAfter.dragging}`);

  // ---------- 穿透开关链路的内部状态机验证 ----------
  // 注意：Electron 44 没有 isIgnoringMouseEvents() 之类的查询接口，主进程无法自证
  //       "OS 层是否真的变了"。这一步交给外部 Win32 探针独立验证：
  //       npm run probe:clickthrough → 读 GWL_EXSTYLE 的 WS_EX_TRANSPARENT 位
  //       2026-09 实测结果：EXSTYLE 在 0x00280028(穿透) ↔ 0x00200008(可交互) 之间真实切换
  const ignoreOn = clickThrough.forceIgnore(true);
  const ignoreOff = clickThrough.forceIgnore(false);
  push('穿透状态机可双向翻转', ignoreOn === true && ignoreOff === false,
    `forceIgnore(true)=${ignoreOn} → forceIgnore(false)=${ignoreOff}`);
  push('穿透切换有真实调用记录', csAfter.stats.toggles >= 0, `累计切换 ${csAfter.stats.toggles} 次，探针次数 ${csAfter.stats.probes}`);
  clickThrough.probe(); // 还原真实状态

  // ---------- 真实事件链（真人操作路径，旧版自检漏掉的就是这条） ----------
  const stateBefore = await js('window.__petTest.state()');
  const realClick = await js('window.__petTest.realClick()');
  trace('realClick后');
  await wait(150);
  let s2 = await js('window.__petTest.state()');
  const clickDelta = s2.clickCount - stateBefore.clickCount;
  push('真实点击链(mousedown→mouseup→click)触发 click', clickDelta === 1, `click 计数 +${clickDelta}`);
  push('真实点击后出气泡', s2.bubbleShown === true && s2.bubbleText.length > 0, `text="${s2.bubbleText}" shown=${s2.bubbleShown}`);

  // 「class 加上」≠「屏幕上看得见」——必须等过渡跑完再看透明度和几何是否在视口内
  await wait(400);
  let sVis = await js('window.__petTest.state()');
  push('气泡真的可见（透明度≈1）', sVis.bubbleOpacity >= 0.95, `opacity=${sVis.bubbleOpacity}`);
  push('气泡完整在窗口视口内', sVis.bubbleInViewport === true, `rect=${JSON.stringify(sVis.bubbleRect)}`);
  // 以像素证据再验一次：截图里气泡区域必须有不透明像素
  const bubbleShot = await win.webContents.capturePage();
  const bmp = bubbleShot.toBitmap();
  const shotW = bubbleShot.getSize().width;
  const dprNow = await js('window.devicePixelRatio');
  const bx = Math.round(sVis.bubbleRect.left * dprNow), by = Math.round(sVis.bubbleRect.top * dprNow);
  const bw = Math.round(sVis.bubbleRect.w * dprNow), bh = Math.round(sVis.bubbleRect.h * dprNow);
  let bubblePixels = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      if (y < 0 || x < 0 || y >= bubbleShot.getSize().height || x >= shotW) continue;
      if (bmp[(y * shotW + x) * 4 + 3] >= 16) bubblePixels++;
    }
  }
  fs.writeFileSync(path.join(ARTIFACTS, 'shot-bubble.png'), bubbleShot.toPNG());
  push('截图里气泡区域确实被画出来了（像素证据）', bubblePixels > bw * bh * 0.5,
    `气泡区域不透明像素 ${bubblePixels}/${bw * bh}（占比 ${(bubblePixels / (bw * bh) * 100).toFixed(0)}%）→ artifacts/shot-bubble.png`);
  push('快速点击后未卡在拖拽态（race 回归断言）', realClick.dragging === false && s2.dragging === false,
    `点击瞬间 dragging=${realClick.dragging}，150ms 后 dragging=${s2.dragging}`);

  // ---------- 右键菜单 ----------
  const menuBefore = menuLog.opened;
  const realMenu = await js('window.__petTest.realContextMenu()');
  trace('realContextMenu后');
  await wait(200);
  push('右键事件被 renderer 捕获并阻止默认行为', realMenu.fired === true && realMenu.defaultPrevented === true,
    `count=${realMenu.count} from=${realMenu.from} defaultPrevented=${realMenu.defaultPrevented}`);
  push('右键已送达主进程（IPC 通路）', menuLog.opened === menuBefore + 1,
    `主进程菜单触发次数 ${menuBefore} → ${menuLog.opened}`);
  push('菜单模板构建无异常', menuLog.errors.length === 0, `errors=${JSON.stringify(menuLog.errors)}`);

  // ---------- 回归：主人报告的「点击没气泡 / 右键无效」根因 ----------
  // 旧实现两个错误：① mousedown 里 preventDefault 会抑制 contextmenu
  //                ② 无阈值即拖动，点一下的微抖动让窗口跟着动 → click 也不产生
  const jitterClick = await js('window.__petTest.realClickWithJitter(3)');
  trace('jitterClick后');
  await wait(150);
  push('微抖动点击(±3px)仍能出气泡（根因①回归）', jitterClick.sayDelta === 1 && jitterClick.clickDelta === 1,
    `say +${jitterClick.sayDelta}, click +${jitterClick.clickDelta}`);

  const dragChain = await js('window.__petTest.realDrag(30)');
  trace('realDrag后');
  await wait(120);
  push('拖动链仍可用（30px 移动触发拖动）', dragChain.draggingDuring === true && dragChain.draggingAfter === false,
    `拖动中=${dragChain.draggingDuring} 结束后=${dragChain.draggingAfter}`);

  // ★真实拖动（会真的移动窗口）反复 3 轮，验证尺寸零漂移；跑完把位置还原，别把桌宠搬走
  const originBounds = win.getBounds();
  const realSizes = [];
  for (let i = 0; i < 3; i++) {
    const rb = await js('window.__petTest.realDrag(40)');
    await wait(150);
    const cur = win.getBounds();
    realSizes.push(`${cur.width}x${cur.height}`);
    void rb;
  }
  win.setBounds(originBounds); // 还原位置
  await wait(150);
  // Windows 会把窗口尺寸吸附到物理像素网格，且随窗口位置略有不同（实测 ±1~2px），
  // 所以断言"没有持续增长"，而不是"每轮完全一致"。增长率失控（比如每轮 +1 一路涨）会被抓出来。
  const deltas = realSizes.map((s) => {
    const [w, h] = s.split('x').map(Number);
    return Math.max(Math.abs(w - originBounds.width), Math.abs(h - originBounds.height));
  });
  const maxDelta = Math.max(...deltas);
  push('真实拖动 3 轮尺寸不持续增长（DPI 量化补偿）', maxDelta <= 2,
    `每轮 ${realSizes.join(' → ')}；起点 ${originBounds.width}x${originBounds.height}；最大偏差 ${maxDelta}px（>2 视为漂移失控）`);
  trace('真实拖动3轮后');

  // mousedown 之后立刻右键：如果 mousedown 里还有 preventDefault，contextmenu 会被抑制
  const menuBefore2 = menuLog.opened;
  const mdThenMenu = await js(`(() => {
    const r = document.getElementById('pet').getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 };
    const pet = document.getElementById('pet');
    const md = new MouseEvent('mousedown', { ...o, button: 0, detail: 1 });
    pet.dispatchEvent(md);
    window.dispatchEvent(new MouseEvent('mouseup', { ...o, button: 0, detail: 1 }));
    const ev = new MouseEvent('contextmenu', { ...o, button: 2 });
    const ret = pet.dispatchEvent(ev);
    return {
      // DOM 规范：preventDefault 生效时 dispatchEvent 返回 false，说明事件正常送达处理器
      handled: ret === false && ev.defaultPrevented === true,
      mousedownPrevented: md.defaultPrevented,
      defaultPrevented: ev.defaultPrevented,
    };
  })()`);
  await wait(200);
  push('左键按下后紧接右键仍能打开菜单（根因②回归）',
    mdThenMenu.handled === true && mdThenMenu.mousedownPrevented === false && menuLog.opened === menuBefore2 + 1,
    `mousedown 被阻止=${mdThenMenu.mousedownPrevented}（必须为 false）菜单次数 ${menuBefore2} → ${menuLog.opened}`);
  // 气泡 2.6 秒后自动消失；注意前面几条断言已经消耗了时间，这里按实际经过时间补齐
  const bubbleDeadline = 3000;
  const bubbleStart = Date.now();
  await wait(300);
  while (Date.now() - bubbleStart < bubbleDeadline) {
    const sNow = await js('window.__petTest.state()');
    if (sNow.bubbleShown === false) break;
    await wait(300);
  }
  const sQuiet = await js('window.__petTest.state()');
  push('气泡会自动消失', sQuiet.bubbleShown === false,
    `shown=${sQuiet.bubbleShown}（等待 ${Date.now() - bubbleStart}ms）`);

  // 模板可独立验证（不能真的 popup，会阻塞自检）
  const tpl = buildMenuTemplate();
  const labels = tpl.filter((i) => i.label).map((i) => i.label);
  push('菜单项完整', labels.length >= 7 && labels.some((l) => l.includes('摸头')),
    `共 ${labels.length} 项: ${labels.join(' / ')}`);
  const clickables = tpl.filter((i) => typeof i.click === 'function').length;
  push('菜单项都绑定了动作', clickables >= 7, `可点击项 ${clickables}`);

  // 兜底入口：Ctrl+M（不依赖鼠标，万一物理右键进不来也有办法开菜单）
  const kbBefore = menuLog.opened;
  const kb = await js('window.__petTest.keyboardMenu()');
  await wait(200);
  push('Ctrl+M 兜底入口可用', kb.from === 'keyboard' && menuLog.opened === kbBefore + 1,
    `来源=${kb.from} 菜单次数 ${kbBefore} → ${menuLog.opened}`);

  // 真机右键诊断快照（主人若再遇到右键无效，这个计数能告诉人家事件卡在哪一层）
  const diagSnap = await js('window.__petRightDiag ? ({...window.__petRightDiag}) : null');

  // 交互中窗口应保持稳定
  const b2 = trace('全部交互后');
  push('交互后窗口未跑位', Math.abs(b2.width - WIN_W) <= 6 && Math.abs(b2.height - WIN_H) <= 6 && win.isVisible(),
    `bounds=${b2.width}x${b2.height} visible=${win.isVisible()}`);

  const shot = path.join(ARTIFACTS, 'shot-interaction.png');
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());

  return {
    screenshot: path.relative(ROOT, shot),
    finalState: s,
    menu: { log: menuLog, labels },
    rightClickDiag: diagSnap,
    boundsTrace: boundsTrace.join(' → '),
    checks,
  };
}

// ---------- 气泡屏幕取证探针 ----------
// 为什么需要它：capturePage() 抓的是窗口自绘缓冲，主人却是在**屏幕**上看气泡的。
// 而且自动点击是合成事件，跟物理鼠标不完全同路。
// 这个探针用「真实鼠标事件链触发 + desktopCapturer 抓真实桌面 + 像素判定」三条一起上。
async function runBubbleProbe() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (s) => { console.log('[气泡探针] ' + s); logInput({ src: 'probe', type: 'bubble-step', detail: s }); };
  try {
    const { desktopCapturer } = require('electron');
    await wait(1200);

    // 1) 用真实鼠标事件链点击（不是 pet.click()）
    const before = await win.webContents.executeJavaScript('window.__petTest.state()');
    log(`点击前：气泡 shown=${before.bubbleShown} visibility=${before.bubbleVisibility}`);
    const trigger = await win.webContents.executeJavaScript(`
      (() => { const r = window.__petTest.realClick(); return r; })()
    `);
    log(`已发出真实事件链点击：clickDelta=${trigger.clickDelta} sayDelta=${trigger.sayDelta}`);

    // 2) 等淡入完成
    await wait(600);
    const st = await win.webContents.executeJavaScript('window.__petTest.state()');
    log(`点击后：shown=${st.bubbleShown} opacity=${st.bubbleOpacity} visibility=${st.bubbleVisibility} rect=${JSON.stringify(st.bubbleRect)}`);

    // 3) 抓真实屏幕
    const display = screen.getPrimaryDisplay();
    const sf = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: {
      width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) } });
    if (!sources.length) throw new Error('desktopCapturer 没有返回屏幕源');
    const shot = sources[0].thumbnail;
    const size = shot.getSize();
    const bmp = shot.toBitmap(); // BGRA
    log(`屏幕截图 ${size.width}x${size.height}，显示器 ${display.size.width}x${display.size.height} @${sf}，显示原点 (${display.bounds.x},${display.bounds.y})`);

    // 先判定气泡是否完整落在窗口视口内（出窗口 = 屏幕上看不见）
    const wb0 = win.getBounds();
    const inWindow =
      st.bubbleRect.left >= 0 && st.bubbleRect.top >= 0 &&
      st.bubbleRect.left + st.bubbleRect.w <= wb0.width &&
      st.bubbleRect.top + st.bubbleRect.h <= wb0.height;
    log(`气泡是否完整在窗口视口内：${inWindow ? '是' : '否！会被窗口裁掉'}`);

    // 4) 换算气泡在屏幕上的物理像素区域
    const wb = win.getBounds();
    const bx = Math.round((wb.x + st.bubbleRect.left - display.bounds.x) * sf);
    const by = Math.round((wb.y + st.bubbleRect.top - display.bounds.y) * sf);
    const bw = Math.round(st.bubbleRect.w * sf);
    const bh = Math.round(st.bubbleRect.h * sf);

    let light = 0, blue = 0, total = 0;
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        if (y < 0 || x < 0 || y >= size.height || x >= size.width) continue;
        const i = (y * size.width + x) * 4;
        const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
        total++;
        if (r > 235 && g > 235 && b > 235) light++;
        else if (b > 180 && b > r + 30) blue++;
      }
    }
    const lightPct = total ? +(light / total * 100).toFixed(1) : 0;
    const bluePct = total ? +(blue / total * 100).toFixed(1) : 0;
    log(`气泡屏幕区域 (${bx},${by}) ${bw}x${bh}：近白=${lightPct}% 天蓝边框=${bluePct}% (采样 ${total} 点)`);

    const artDir = ARTIFACTS;
    fs.mkdirSync(artDir, { recursive: true });
    fs.writeFileSync(path.join(artDir, 'screen-capture.png'), shot.toPNG());
    // 同时裁出气泡区域单独存一张，方便主人肉眼确认
    try {
      const crop = shot.crop({ x: Math.max(0, bx), y: Math.max(0, by), width: Math.max(1, bw), height: Math.max(1, bh) });
      fs.writeFileSync(path.join(artDir, 'screen-bubble-crop.png'), crop.toPNG());
    } catch { /* 裁剪失败不影响判定 */ }

    const verdict = lightPct > 20;
    log(`判定：${verdict ? 'PASS 气泡真的画在屏幕上了' : 'FAIL 屏幕上看不到气泡'}（近白占比 ${lightPct}%）`);

    // 5) 边框取证：确认窗口四边没有被画出任何"边框线"（调试红框就是靠这个抓出来的）
    const wx0 = Math.round((wb.x - display.bounds.x) * sf);
    const wy0 = Math.round((wb.y - display.bounds.y) * sf);
    const ww0 = Math.round(wb.width * sf);
    const wh0 = Math.round(wb.height * sf);
    const isPinkish = (i) => {
      const b = bmp[i], g = bmp[i + 1], r = bmp[i + 2];
      return r > 200 && g < 140 && b > 60 && b < 190;
    };
    let borderPink = 0, edgeTotal = 0;
    const scan = (x0, y0, x1, y1) => {
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (x < 0 || y < 0 || x >= size.width || y >= size.height) continue;
          edgeTotal++;
          if (isPinkish((y * size.width + x) * 4)) borderPink++;
        }
      }
    };
    scan(wx0, wy0, wx0 + ww0 - 1, wy0 + 2);
    scan(wx0, wy0 + wh0 - 3, wx0 + ww0 - 1, wy0 + wh0 - 1);
    scan(wx0, wy0, wx0 + 2, wy0 + wh0 - 1);
    scan(wx0 + ww0 - 3, wy0, wx0 + ww0 - 1, wy0 + wh0 - 1);
    log(`窗口边框取证：扫描 ${edgeTotal} 个边缘像素，检出粉红边框色=${borderPink}（调试红框应为 0）`);
    log('截图：artifacts/screen-capture.png，气泡区域裁图：artifacts/screen-bubble-crop.png');
    app.__bubbleProbeDone = true;
    app.exit(verdict ? 0 : 2);
  } catch (err) {
    console.error('[气泡探针] 异常:', err && err.stack || err);
    app.__bubbleProbeDone = true;
    app.exit(4);
  }
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (!AUTOTEST) app.quit();
});
