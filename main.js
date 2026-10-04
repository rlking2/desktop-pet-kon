// 桌宠 · 主进程（通用机制，不含具体主题形象）
// 阶段0 目标：透明 / 无边框 / 永远置顶 / 能拖 / 右键菜单 / AUTOTEST 自检
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { installClickThrough } = require('./lib/click-through');
const { loadAnimationManifest } = require('./lib/assets');
// API 设置 + 对话：都只在主进程用（密钥绝不发给渲染层，理由见 lib/api-config.js 顶部注释）
const apiConfig = require('./lib/api-config');
const chatApi = require('./lib/chat');
const actionLines = require('./lib/action-lines');

const ROOT = __dirname;
const ARTIFACTS = path.join(ROOT, 'artifacts');
const AUTOTEST = process.env.DSH_PET_AUTOTEST === '1';
const WIN_W = 200;
const WIN_H = 250;
const MARGIN = 30;
// 待办面板展开时，窗口要向左扩展出"面板列 + 桌宠列"。
// 桌宠列宽度取决于**素材的真实宽高比**（竖构图素材列更窄），由渲染层回报，所以这里是兜底值。
// 三个必须守住的点（都是踩坑换来的）：
//   1) **桌宠的屏幕位置绝对不动** —— 主人点的是它，它就该待在那儿；动的是窗口边界和面板
//   2) 窗口尺寸**必须真的变，且要够宽** —— 288px 的面板塞进 200px 的窗口会被裁掉
//   3) 改尺寸后**必须重算穿透掩码**，否则点击判定范围还停留在旧尺寸上
let panelWinW = 470;
const PANEL_H = 250;   // 与收起态同高（人物位置天然不变）
let panelOpen = false;
let panelSide = null;
// 气泡列宽度（第 26 轮）：
//   主人反馈"回复与提问窗口总在同一侧"——因为气泡原本居中在**整个窗口**里，
//   面板展开后它是骑在"面板列 + 桌宠列"中间的，看起来就压着提问框。
//   修法不是"把气泡往边上推"（推出去就被窗口裁掉，实测气泡被推到 -42px），
//   而是**给气泡专门留一列**：窗口 = [气泡列][面板列][桌宠列]（面板在右时）。
//   气泡的 CSS 是 left:50% 居中，所以只要"气泡列"在两种状态下一样宽，
//   同一句话就永远出现在屏幕上的同一个位置，且**永远不碰面板**（列与列不重叠）。
//   初始 220 是兜底；渲染层启动后会量出真实宽度并回报（见 pet:set-bubble-width）。
//   第 27 轮起气泡是固定 150px 宽（放在她左上方那一小块），气泡列 = 150 + 两侧余量 ≈ 190。
let BUBBLE_COL = 190;
// 桌宠列宽度（实测）：窗口宽度 = BUBBLE_COL + 面板列 + PET_COL，三者要严丝合缝，
// 否则 grid 会把多出来的像素摊到左边 → 桌宠/气泡整体偏移（第 26 轮实测偏 73px）。
// 初始值按"显示宽度 + 28 边距"估，渲染层量到解析值后会回报更准的（见 pet:set-pet-column）。
let PET_COL = 198;

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
    fs.writeFileSync(inputLogPath, `# 桌宠 原始输入日志\n# 开始时间 ${new Date().toISOString()}\n# Electron ${process.versions.electron}\n`);
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
//
// ★ 为什么第二次启动要"说句话"：
//   打包成 桌宠.exe 之后，主人是双击启动的。如果已经有一只在跑（比如之前用 npm start 开的那只），
//   第二个进程会拿不到锁 → 直接退出 → 主人看到的是"双击了但什么都没发生"，以为程序坏了。
//   所以这里除了把已有窗口叫到前面，还让她**冒个气泡**说明情况。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    win.show();
    win.focus();
    logInput({ src: 'main', type: 'second-instance', detail: '第二次启动：已把现有窗口叫到前面' });
    try { win.webContents.send('pet:say', '人家在这儿呢～（一次只能有一只哦）'); } catch { /* 窗口还没加载好就算了 */ }
  });
}

function createWindow() {
  const work = screen.getPrimaryDisplay().workArea;
  initInputLog();

  win = new BrowserWindow({
    // ★ 收起态也要带"气泡列"（第 26 轮）：气泡平时居中在**桌宠那一列**，
    //   而面板展开后桌宠列会被挤到最右边 —— 如果不给气泡留出固定的一列，
    //   同一句话就会在"开面板/关面板"两种状态下出现在两个位置，看着像漂移。
    //   所以收起态窗口宽度 = 气泡列 + 桌宠列，气泡始终居中在气泡列里。
    width: closedWidth(),
    height: WIN_H,
    x: process.env.DSH_PET_POS === 'top' ? work.x + 60 : work.x + work.width - closedWidth() - MARGIN,
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
    title: '桌宠',
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
  clickThrough = installClickThrough(win, {
    // 鼠标离开整个窗口 → 通知渲染层（用于"点区域外自动关闭待办面板"）
    // 为什么必须由主进程来报：窗口透明，鼠标移出后点击会穿透到桌面，渲染层收不到事件
    onPointerOutside: () => {
      if (!win || win.isDestroyed()) return;
      win.webContents.send('pet:pointer-outside');
    },
  });
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
      // 面板测试要等窗口缩放 + 穿透掩码重算，整体耗时比以前长，所以时限放宽到 60 秒
      setTimeout(() => {
        if (!app.__selfCheckDone) {
          console.log('[AUTOTEST] TIMEOUT: 自检未完成，强制收尾');
          app.exit(3);
        }
      }, 60000);
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
            const cw = Math.round(targetWidth());
            // 拖动防漂移靠 __designSize 锁存，这里搬完窗口必须同步，否则下次拖动会拿旧尺寸回写
            win.setBounds({ x: work.x + work.width - cw - MARGIN, y: work.y + work.height - WIN_H - MARGIN, width: cw, height: WIN_H });
            win.__designSize = { w: cw, h: WIN_H };
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
        { label: '关于桌宠', click: () => {
            if (!win || win.isDestroyed()) return;
            const { dialog } = require('electron');
            dialog.showMessageBox(win, {
              type: 'info',
              title: '关于',
              message: '桌宠',
              detail: `透明置顶 + 逐像素鼠标穿透 + 自动自检\n\nElectron ${process.versions.electron}\nChrome ${process.versions.chrome}\nNode ${process.versions.node}\n\n形象完全由 assets/ 里的素材决定，代码不写死任何主题。\n日志目录：artifacts/`,
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
    { label: '桌宠 · 阶段1', enabled: false },
    { type: 'separator' },
    // 「开心」是**开关**：点一次保持住这个动作（不自动收尾），再点一次才退出。
    // 勾选状态由渲染层回报（menuState.poseGroup），所以主人一眼能看出现在是不是保持中。
    { label: '开心（保持动作）', type: 'checkbox', checked: menuState.poseGroup === 'happy', click: () => win.webContents.send('pet:action', 'happy') },
    { label: '摸头', click: () => win.webContents.send('pet:action', 'headpat') },
    { type: 'separator' },
    // 「设置…」= 接入 API 的入口（填 Base URL / 模型 / 密钥）。
    // 独立窗口，不是塞进桌宠那个透明窗口：表单需要正常的尺寸和焦点。
    //
    // 「安静一会儿」= 一键静音空闲主动开口（第 32 轮）。为什么是**复选框**而不是一次性动作：
    //   主人嫌吵的时候要能一眼看出"现在是静音着的"，再点一下就是恢复 —— 否则他会以为她坏了。
    //   注意它只静音**主动开口**，主人自己打字聊天不受影响。
    { label: '安静一会儿（不要主动开口）', type: 'checkbox', checked: !!apiConfig.load().muted, click: () => toggleMute(undefined, 'menu') },
    { label: '设置…（接入 API / 她的话）', click: () => openSettingsWindow('menu') },
    { type: 'separator' },
    { label: '回到底部右侧', click: () => {
        const work = screen.getPrimaryDisplay().workArea;
        const cw = Math.round(targetWidth());
            // 拖动防漂移靠 __designSize 锁存，这里搬完窗口必须同步，否则下次拖动会拿旧尺寸回写
            win.setBounds({ x: work.x + work.width - cw - MARGIN, y: work.y + work.height - WIN_H - MARGIN, width: cw, height: WIN_H });
            win.__designSize = { w: cw, h: WIN_H };
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

// 鼠标此刻的屏幕坐标 + 窗口边界：给渲染层做"靠近→离开"的兜底判定。
// 为什么要这个：鼠标离开角色后窗口可能立刻进入穿透态（setIgnoreMouseEvents(true, forward)），
// 而穿透态的窗口**不一定还能收到 mousemove** → 渲染层的 setHover(false) 就永远等不到，
// 人物卡在「靠近」那一帧（主人 2026-09-25 反馈：往下/往右移开不恢复待机动作）。
//
// ⚠️ 自检时屏幕坐标这条路走不通：`win.getBounds()`（Electron 的逻辑像素）和渲染层
//    `window.screenX`（Chromium 的 CSS 像素）在 150% DPI 下**不是同一个数**，
//    拿两头凑出来的"假鼠标位置"会落在角色里面，兜底判定永远 inside=true（人家第一版就白跑了）。
//    所以自检直接给 `win.__fakeCursor`（**窗口内坐标**），这里原样返回、不再做换算。
ipcMain.handle('pet:get-cursor', () => {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  if (win.__fakeCursor) {
    return { screenX: win.__fakeCursor.x, screenY: win.__fakeCursor.y, fake: true, relative: true,
             winX: 0, winY: 0, winW: b.width, winH: b.height };
  }
  try {
    const pt = screen.getCursorScreenPoint();
    return { screenX: pt.x, screenY: pt.y, winX: b.x, winY: b.y, winW: b.width, winH: b.height, fake: false, relative: false };
  } catch {
    return { screenX: null, screenY: null, winX: b.x, winY: b.y, winW: b.width, winH: b.height, fake: false, relative: false };
  }
});

// 素材清单：主进程读磁盘 → 渲染层用（避开 CSP 对 fetch 的限制）
ipcMain.handle('pet:asset-manifest', () => loadAnimationManifest(path.join(ROOT, 'assets')));

// 「保持动作」状态：渲染层是真状态，主进程只存一份镜像，用来给右键菜单打勾。
// （菜单是每次右键时现搭的，所以直接读这份镜像即可。）
const menuState = { poseGroup: null };
ipcMain.on('pet:pose', (_e, payload) => {
  const group = payload && payload.group ? String(payload.group) : null;
  menuState.poseGroup = group;
  logInput({ src: 'renderer', type: 'pose', detail: group ? `保持动作 = ${group}` : '保持动作已退出' });
});

// 待办面板：展开时把窗口**横向**扩展，面板出现在桌宠的右侧（右侧放不下就放左侧）。
//
// 三个必须守住的点（都是踩坑换来的）：
//   1) **桌宠的屏幕位置绝对不动** —— 主人点的是她，她就该待在那儿；动的是窗口边界和面板
//   2) 窗口尺寸**必须真的变** —— 否则 288px 宽的面板会被 200px 宽的窗口裁掉（实测 panelLeft=-9）
//   3) 改尺寸后**必须重算穿透掩码**，否则点击判定范围还停留在旧尺寸上

ipcMain.on('pet:set-panel', (_e, payload) => {
  if (!win || win.isDestroyed()) return;
  const open = !!(payload && payload.open);
  if (open === panelOpen) return;
  panelOpen = open;

  const display = screen.getPrimaryDisplay();
  const work = display.workArea;      // 逻辑像素
  const b = win.getBounds();

  let target;
  if (open) {
    // 宽度 = [气泡列][面板列][桌宠列]（面板在右时）—— 气泡有自己的一列，就不会压到面板上
    const need = Math.round(openWidth());
    // ★ 桌宠的屏幕位置按"当前窗口右边界"算 —— 桌宠列永远贴着窗口右边，所以
    //   `b.x + b.width` 就是她在屏幕上的右边界，收起态和展开态都成立。
    //   窗口的**右边界不动**、只往左长，桌宠就一动不动（自检有专项断言盯这条）。
    //   （第 26 轮踩过的坑：老写法"基于当前 bounds 推左边界"会被工作区左边界夹住，
    //     夹住之后窗口只能往右长 → 桌宠被推走 231px。锚点法的规矩是"先定人物在哪，再让窗口适配"。）
    const petRightNow = b.x + b.width;
    const x = Math.max(work.x, Math.min(petRightNow - need, work.x + work.width - need));
    target = { x: Math.round(x), y: b.y, width: need, height: WIN_H, side: 'right' };
  } else {
    // 收起：还原成 `[气泡列][桌宠列]`（面板列消失、气泡回到她正上方），右边界不动 → 桌宠不动
    const closedW = Math.round(closedWidth());
    const x = Math.max(work.x, b.x + b.width - closedW);
    target = { x: Math.round(x), y: b.y, width: closedW, height: WIN_H, side: null };
  }

  win.__panelSide = target.side;
  win.setBounds({ x: target.x, y: target.y, width: target.width, height: target.height });
  win.__designSize = { w: target.width, h: target.height }; // 拖动时用它，避免"缩回"旧尺寸
  win.webContents.send('pet:panel-side', target.side); // 通知渲染层调整布局方向
  logInput({ src: 'main', type: 'panel',
    detail: `${open ? '展开' : '收起'}面板 → 窗口 ${target.width}x${target.height} @(${target.x},${target.y}) 侧=${target.side}` });

  // 尺寸变了 → 掩码必须重算（等布局稳定）
  setTimeout(() => {
    if (!clickThrough) return;
    clickThrough.refreshMask()
      .then((m) => {
        logInput({ src: 'main', type: 'mask-refresh', detail: `面板切换后重算：覆盖率=${m.coverage} bbox=${JSON.stringify(m.bbox)}` });
      })
      .catch((err) => console.error('[穿透掩码] 面板切换后重算失败:', err && err.message));
  }, 300);
});

// 面板里的输入框要能打字 → 需要把键盘焦点交给窗口
ipcMain.on('pet:focus-window', () => {
  if (!win || win.isDestroyed()) return;
  win.focus();
  win.webContents.focus();
});
// 收起态 / 展开态宽度（第 29 轮定稿）：
//   三个东西都是**绝对定位**（见 style.css）：人物钉在右下角；面板打开时**紧贴她的左边**；
//   气泡紧跟人物（收起在她左上、展开在她右上 —— 主人 2026-09-27 定的）。
//     收起：气泡段 + 人物列
//     展开：人物列 + 面板（300）+ 气泡段  ← 面板贴着她左边，气泡在她右边，两边都得留够
function bubbleSpan() { return Math.max(PET_COL, BUBBLE_COL); }
function closedWidth() { return Math.round(PET_COL + bubbleSpan()); }
function openWidth() { return Math.round(PET_COL + 300 + bubbleSpan()); }
function targetWidth() { return panelOpen ? openWidth() : closedWidth(); }

// 把窗口摆正：**右边界不动**，只改宽度（桌宠贴右边 → 屏幕位置天然不变）。
function applyWindowWidth(reason) {
  if (!win || win.isDestroyed()) return null;
  const work = screen.getPrimaryDisplay().workArea;
  const b = win.getBounds();
  const width = Math.round(targetWidth());
  if (Math.abs(b.width - width) < 2) return { x: b.x, width: b.width };   // 没变化就别折腾窗口
  const x = Math.max(work.x, b.x + b.width - width);
  win.setBounds({ x: Math.round(x), y: b.y, width, height: WIN_H });
  win.__designSize = { w: width, h: WIN_H };
  logInput({ src: 'main', type: 'window-width',
    detail: `${reason} → 窗口 ${width}x${WIN_H} @(${Math.round(x)},${b.y})（右边界固定在 ${b.x + b.width}）` });
  if (clickThrough) setTimeout(() => clickThrough.refreshMask().catch(() => {}), 200);
  return { x: Math.round(x), width };
}

// 素材形状回报：渲染层量出"最宽那一帧"的宽高比后告诉主进程，
// 主进程据此决定：
//   1) 桌宠列宽度 = 显示宽度 + 边距（竖构图素材列更窄，窗口就能小一点）
//   2) 窗口宽度 = 气泡列 + 面板列 + 桌宠列（气泡列见下面 pet:set-bubble-width）
// 为什么不让主进程自己算：帧尺寸信息在 manifest 里，但"显示框"是渲染层的事
// （CSS 尺寸 + DPR 缩放），由渲染层回报最准。
ipcMain.on('pet:set-content-ratio', (_e, payload) => {
  const ratio = payload && Number(payload.ratio);
  if (!ratio || !Number.isFinite(ratio) || ratio <= 0) return;
  // 显示高度固定 200px（竖构图），宽度按素材比例算，并夹在合理范围
  const dispW = Math.max(60, Math.min(200, Math.round(200 * ratio)));
  PET_COL = dispW;                         // 桌宠列 = 桌宠显示宽度（渲染层随后会给实测值覆盖）
  panelWinW = 300 + PET_COL;               // 面板列固定 300（288 面板 + 6 边距 ×2）+ 桌宠列
  logInput({ src: 'main', type: 'content-ratio',
    detail: `素材宽高比 ${ratio.toFixed(3)} → 显示 ${dispW}x200，桌宠列 ≈${PET_COL}，窗口宽 ${panelWinW}（另加气泡列 ${BUBBLE_COL}）` });
  if (!panelOpen) applyWindowWidth('素材比例回报后重设窗口宽度');
});

// 气泡列宽度：渲染层量出气泡真实宽度后回报。
// 为什么要由渲染层量：气泡宽度是 CSS 决定的（内容上限 192 + 内边距 + 边框），
// 主进程凭空猜容易猜小 —— 猜小了气泡就会被窗口裁掉（第 26 轮第一次修就是这么翻车的）。
ipcMain.on('pet:set-bubble-width', (_e, payload) => {
  const w = payload && Number(payload.width);
  if (!w || !Number.isFinite(w) || w < 120 || w > 400) return;
  const next = Math.round(w);
  if (Math.abs(next - BUBBLE_COL) < 2) return;
  BUBBLE_COL = next;
  logInput({ src: 'main', type: 'bubble-col', detail: `气泡列宽度 = ${BUBBLE_COL}px（窗口宽 = 气泡列 + 面板列 ${panelWinW}）` });
  if (!panelOpen) applyWindowWidth('气泡列宽度变化后重设收起态宽度');
});

// 实测的桌宠列宽度（grid 最后一列的解析宽度）：渲染层回报。
// 为什么要它：窗口宽度必须**正好等于三列之和**，多一个像素都会被 grid 摊到左边、把桌宠推偏。
// 主进程原来按"显示宽度 + 边距"估算，实测差了 2px → 桌宠偏 73px（第 26 轮踩的）。
ipcMain.on('pet:set-pet-column', (_e, payload) => {
  const w = payload && Number(payload.width);
  if (!w || !Number.isFinite(w) || w < 80 || w > 400) return;
  const next = Math.round(w);
  // ★ 每次都要把 CSS 的 --sprite-w 同步成"sprite 的真实宽度"（第 27 轮踩的坑）：
  //   网格列宽是 `var(--sprite-w)`，而 sprite 的显示宽度由素材比例决定。
  //   网格列比 sprite 窄 → 人物**溢出到列外**（实测溢出 37px）→ 窗口比"三列之和"宽出一截
  //   → grid 把那截空白塞在她**左边** → 气泡看着离她很远（主人就是因为这个说"脱离人物"）。
  if (win && !win.isDestroyed()) {
    try {
      win.webContents.executeJavaScript(
        `(() => { const p = document.getElementById('pet'), s = document.getElementById('sprite');`
        + ` p.style.setProperty('--sprite-w', '${next}px'); p.style.width = '${next}px'; s.style.width = '${next}px'; return true; })()`).catch(() => {});
    } catch { /* 窗口还没加载完就算了 */ }
  }
  if (Math.abs(next - PET_COL) < 1) return;
  PET_COL = next;
  logInput({ src: 'main', type: 'pet-column', detail: `桌宠列宽（实测）= ${PET_COL}px` });
  if (!panelOpen) applyWindowWidth('桌宠列宽实测回报后重设窗口宽度');
});

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
        spriteRect: rect('#sprite'),
        canvasSize: (() => { const c = q('#sprite'); return c ? (c.width + 'x' + c.height) : null; })(),
        bubbleText: (q('#bubble') || {}).textContent || '',
        dragRegion: getComputedStyle(q('#pet')).webkitAppRegion || 'none',
        // 帧动画 / 空位状态
        sprite: (window.__petTest && window.__petTest.state) ? window.__petTest.state().sprite : null,
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
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // 打包身份断言（安装包踩坑换来的）：
    //   Electron 用 app.getName() 拼 userData 目录（%APPDATA%\<name>），而 electron-builder
    //   默认把 productName 当名字注入打包后的 package.json → 安装版的待办事项会另开一份
    //   （便携版存的看不见），单实例锁也会分成两把。所以这里把"名字必须还是仓库包名"钉死。
    //   注意：自检为了不影响主人的那只桌宠会加 --user-data-dir 做隔离，那种情况下
    //   userData 目录名当然是临时的 —— 只查名字，不查目录名。
    const userDataOverridden = process.argv.some((a) => a.startsWith('--user-data-dir'));
    push('打包身份未被改（app.getName() 仍是仓库包名，userData 才不会被分家）',
      app.getName() === 'dsh-desktop-pet' &&
      (userDataOverridden || path.basename(app.getPath('userData')) === 'dsh-desktop-pet'),
      `app.getName()=${app.getName()}；userData=${app.getPath('userData')}` +
      `${userDataOverridden ? '（自检用了 --user-data-dir 隔离，属正常）' : ''}` +
      '；名字若被改成"桌宠"，便携版的待办事项会看不见，还会跑出两只桌宠');
    push('窗口可见', state.windowVisible === true, `visible=${state.windowVisible}`);
    push('永远置顶生效', state.alwaysOnTop === true, `alwaysOnTop=${state.alwaysOnTop}`);
    // 用页面视口（逻辑 CSS 像素）判定尺寸；Windows 在高 DPI 下会把窗口吸到整数物理像素网格，
    // 1.5 缩放时 260x320 会变成 264x324，属于系统行为，不是 bug → 给 ±4 逻辑像素容差
    const TOL = 6; // 加上菜单栏可能带来的 1px 取整，容差放宽到 ±6
    const dw = Math.abs(metrics.innerSize.w - closedWidth());
    const dh = Math.abs(metrics.innerSize.h - WIN_H);
    push('窗口尺寸符合设计(±4)', dw <= TOL && dh <= TOL,
      `视口 ${metrics.innerSize.w}x${metrics.innerSize.h} / 设计 ${closedWidth()}x${WIN_H}（= 气泡列 ${BUBBLE_COL} + 面板列 ${panelWinW}；偏差 ${dw}x${dh}，DPR ${state.devicePixelRatio}）`);
    push('完整落在工作区内', state.insideWorkArea === true, `bounds=${JSON.stringify(b)} workArea=${JSON.stringify(display.workArea)}`);
    push('透明背景（body 非纯色）', /rgba\(0, 0, 0, 0\)|transparent/.test(metrics.bodyBg), `bodyBg=${metrics.bodyBg}`);
    push('角色容器已渲染', metrics.petVisible === true && !!metrics.petRect, `petRect=${JSON.stringify(metrics.petRect)}`);
    push('角色画布存在', !!metrics.spriteRect && !!metrics.canvasSize,
      `canvas=${metrics.canvasSize} spriteRect=${JSON.stringify(metrics.spriteRect)}`);
    // 显示框应该**贴合素材真实宽高比**（竖构图素材 → 竖矩形，人物更大更清晰）
    {
      const sp0 = metrics.sprite || {};
      if (sp0.available && sp0.display) {
        const ratioOk = Math.abs(sp0.display.ratio - (sp0.display.w / sp0.display.h)) < 0.02;
        push('显示框贴合素材宽高比（竖矩形）',
          sp0.display.h === 200 && sp0.display.w >= 60 && sp0.display.w <= 200 && ratioOk,
          `显示框 ${sp0.display.w}x${sp0.display.h}  素材比例 ${sp0.display.ratio}`);
      } else {
        push('空位提示模式下显示框为正方形（无素材可贴合）',
          metrics.canvasSize === '130x130', `canvas=${metrics.canvasSize}`);
      }
    }
    // 主人 2026-09-24 要求去掉"靠近后底下那行白色提示"（「按住拖我走 · 右键有菜单」），
    // 连 .pet 的 title="按住拖动" 原生提示一起去掉了。这条断言防止以后被人手滑加回来。
    {
      const hintEl = await js('!!document.querySelector(".hint")');
      const petTitle = await js('document.getElementById("pet").getAttribute("title")');
      const petRectNoHint = await js(`(() => { const r = document.getElementById('pet').getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);
      push('靠近时不再有任何提示文字/提示气泡（主人要求去掉）',
        hintEl === false && !petTitle,
        `.hint 元素存在=${hintEl}；#pet 的 title=${petTitle === null ? '（无）' : `"${petTitle}"`}`
        + `；命中区 ${petRectNoHint.w}x${petRectNoHint.h}（正好等于角色本身，不再多出提示那一截）`);
    }
    // 角色渲染状态：有素材在播帧动画，没素材画"空位提示"。两条路都必须真的画出东西
    // （否则整个窗口都是空气 → 鼠标事件进不来 → 点击/拖动/穿透全部失效）
    {
      const sp = metrics.sprite || {};
      if (sp.available) {
        push('帧动画已启用', sp.placeholder === false && (sp.groups || []).length > 0 && sp.drewFrames > 0,
          `动作=[${(sp.groups || []).join(', ')}] 待机=${sp.baseGroup} 已绘制 ${sp.drewFrames} 帧`);
        // 四个动作组各自独立可用（主人分配：待机 7/8/9、交互 1/5/6、靠近 J、开心 = 主人给的那张定格图）
        const need = ['idle', 'interact', 'hover', 'happy'];
        const missing = need.filter((n) => !(sp.groups || []).includes(n));
        push('待机/交互/靠近/开心 四组动作都已加载', missing.length === 0,
          missing.length ? `缺少: ${missing.join(', ')}（现有: ${(sp.groups || []).join(', ')}）` : `四组齐全: ${need.join(', ')}`);
      } else {
        push('无素材时显示空位提示（保证可点可拖、穿透掩码有实体）',
          sp.placeholder === true && sp.drewFrames > 0,
          `已绘制 ${sp.drewFrames} 帧；未启用素材原因：${sp.reason}`);
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

    // ---------- 待办面板断言 ----------
    {
      await js('window.__petTest.memoClear()');
      await js('window.__petTest.memoClose()');
      await wait(150);
      const closed = await js('window.__petTest.memoSnapshot()');
      push('面板默认收起', closed.open === false && closed.panelVisible === false,
        `open=${closed.open} visible=${closed.panelVisible}`);

      // 点击桌宠应展开面板
      await js('window.__petTest.click()');
      await wait(500);
      const opened = await js('window.__petTest.memoSnapshot()');
      push('左键点击桌宠展开待办面板', opened.open === true && opened.panelVisible === true,
        `open=${opened.open} visible=${opened.panelVisible}`);
      push('面板默认容量 4 栏、两列布局', opened.cap === 4 && opened.renderedRows === 4,
        `容量=${opened.cap} 渲染栏位=${opened.renderedRows} 空栏位=${opened.emptyRows}`);
      push('每栏都有勾选框', opened.boxCount === 4, `勾选框数=${opened.boxCount}`);
      push('输入框获得键盘焦点（能打字）', opened.inputFocused === true,
        `focused=${opened.inputFocused}`);
      push('面板完整在窗口内（不会被裁掉）', opened.panelInViewport === true,
        `panelRect=${JSON.stringify(opened.panelRect)}`);
      push('面板里已没有 × 关闭按钮', opened.closeButtonExists === false,
        `#memoClose 存在=${opened.closeButtonExists}`);

      // 添加任务（走真实的输入框回车路径）
      const added = await js(`(() => {
        const input = document.getElementById('memoInput');
        const out = [];
        for (const t of ['写文档', '修 bug', '喂桌宠']) {
          input.focus();
          input.value = t;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
          out.push(document.getElementById('memoList').querySelectorAll('.memo-item:not(.empty)').length);
        }
        return { counts: out };
      })()`);
      await wait(150);
      const withTasks = await js('window.__petTest.memoSnapshot()');
      push('回车可添加任务（顶部输入栏）', withTasks.count === 3 && added.counts.join(',') === '1,2,3',
        `加入 ${withTasks.count} 条：${withTasks.tasks.join(' / ')}（逐次计数 ${added.counts.join(',')}）`);
      push('任务按顺序落入下方栏位', withTasks.tasks[0] === '写文档' && withTasks.tasks[2] === '喂桌宠',
        `tasks=${JSON.stringify(withTasks.tasks)}`);
      push('空栏位数量随之减少', withTasks.emptyRows === 1, `空栏位=${withTasks.emptyRows}（4 栏 - 3 条）`);

      // 勾选第 2 栏 → 完成并删除
      await js('window.__petTest.memoComplete(1)');
      await wait(450);
      const afterDone = await js('window.__petTest.memoSnapshot()');
      push('点击小方框＝完成任务并删除该栏',
        afterDone.count === 2 && !afterDone.tasks.includes('修 bug') && afterDone.removedTotal === 1,
        `剩余 ${afterDone.count} 条：${afterDone.tasks.join(' / ')}（累计删除 ${afterDone.removedTotal} 条）`);
      push('删除后栏位重排且恢复空槽', afterDone.renderedRows === 4 && afterDone.emptyRows === 2,
        `渲染栏位=${afterDone.renderedRows} 空栏位=${afterDone.emptyRows}`);

      // 容量上限
      // 超过默认可见栏数 → 不再拒绝，改为列表区域出现滚动
      const beforeFill = await js('window.__petTest.memoSnapshot()');
      const fill = await js(`(() => {
        const r = [];
        for (let i = 0; i < 12; i++) r.push(window.__petTest.memoAdd('溢出测试' + i).added);
        return r;
      })()`);
      await wait(250);
      const full = await js('window.__petTest.memoSnapshot()');
      const okCount = fill.filter((v) => v === true).length;
      push('超过 4 条时全部接受（不再硬拒绝）', okCount === 12 && full.count === beforeFill.count + 12,
        `12 次添加全部成功（${okCount}/12），任务数 ${beforeFill.count} → ${full.count}`);
      // 说明：两列布局 + 88px 可视高（第 25 轮从 130px 让位给「和她说…」输入行）
      // → 3 行装得下（6 条），第 7 条开始溢出滚动。
      push('任务多到超过可见栏数后列表自动可滚动', full.scrollable === true && full.maxScroll > 0,
        `任务数=${full.count} scrollable=${full.scrollable} 内容高=${full.scrollHeight} 可视高=${full.clientHeight} 可滚动距离=${full.maxScroll}px`);
      push('滚动区可视高度固定（不随任务数抖动）', full.clientHeight === 88,
        `可视高度=${full.clientHeight}px（CSS 固定 88px；3 行 × 22px + 2 × 5px 间距 = 76px，留出半行提示"下面还有"）`);

      // 滚动后能露出后面的任务（注意量的是外层滚动容器 #memoScroll，不是内层网格）
      const scrolled = await js('window.__petTest.memoScrollTo(99999)');
      await wait(120);
      const tailVisible = await js(`(() => {
        const wrap = document.getElementById('memoScroll');
        const items = wrap.querySelectorAll('.memo-item:not(.empty)');
        const lastEl = items[items.length - 1];
        if (!lastEl) return null;
        const r = lastEl.getBoundingClientRect(), c = wrap.getBoundingClientRect();
        return { text: lastEl.textContent.trim(), visible: r.bottom <= c.bottom + 1 && r.top >= c.top - 1,
                 scrollTop: Math.round(wrap.scrollTop), maxScroll: wrap.scrollHeight - wrap.clientHeight };
      })()`);
      push('滚动到底能看见最后一条任务',
        tailVisible && tailVisible.visible === true && tailVisible.scrollTop > 0 &&
        tailVisible.scrollTop === tailVisible.maxScroll,
        `最后一条="${tailVisible && tailVisible.text}" 完整可见=${tailVisible && tailVisible.visible} ` +
        `scrollTop=${tailVisible && tailVisible.scrollTop}/${tailVisible && tailVisible.maxScroll}`);
      push('添加新任务时自动滚动到底（新条可见）',
        scrolled.scrollTop > 0 && scrolled.scrollTop === scrolled.maxScroll,
        `添加后 scrollTop=${scrolled.scrollTop} / maxScroll=${scrolled.maxScroll}`);

      // 删除到 4 条 → 正好填满默认可见栏数，不用滚动
      // 注意用同步删除：真实删除带 220ms 删除线动画，循环调用会互相打架
      const shrink = await js(`(() => {
        let guard = 0;
        while (window.__petTest.memoSnapshot().count > 4 && guard++ < 60) window.__petTest.memoCompleteNow(0);
        return window.__petTest.memoSnapshot();
      })()`);
      await wait(300);
      const afterShrink = await js('window.__petTest.memoSnapshot()');
      push('删到 4 条后滚动条消失（回到默认可见栏数）',
        afterShrink.count === 4 && afterShrink.scrollable === false && afterShrink.maxScroll === 0,
        `任务数=${afterShrink.count} scrollable=${afterShrink.scrollable} maxScroll=${afterShrink.maxScroll} 渲染栏位=${afterShrink.renderedRows}`);
      push('4 条时正好填满可见区（不用滚动）', afterShrink.renderedRows >= 4 && afterShrink.clientHeight === 88,
        `渲染栏位=${afterShrink.renderedRows}（4 条）可视高=${afterShrink.clientHeight}px`);

      // 收起面板：窗口应还原尺寸
      const boundsBeforeClose = win.getBounds();
      await js('window.__petTest.memoClose()');
      await wait(700);
      const closedAgain = await js('window.__petTest.memoSnapshot()');
      const boundsAfterClose = win.getBounds();
      push('收起面板后还原窗口尺寸',
        closedAgain.open === false && Math.abs(boundsAfterClose.width - closedWidth()) <= 6 && Math.abs(boundsAfterClose.height - WIN_H) <= 6,
        `窗口 ${boundsBeforeClose.width}x${boundsBeforeClose.height} → ${boundsAfterClose.width}x${boundsAfterClose.height}（设计 ${closedWidth()}x${WIN_H} = 气泡列 ${BUBBLE_COL} + 面板列 ${panelWinW}）`);

      // 面板展开时窗口真的变宽了（否则面板会被裁掉）
      const bClosed = win.getBounds();
      // 面板开合前后各量一次「桌宠屏幕位置」和「气泡左边界」：
      //   桌宠必须一动不动（主人明确要求），气泡也必须一动不动（气泡列在两种状态下一样宽）
      const petScreenBefore = await js(`(() => {
        const r = document.getElementById('pet').getBoundingClientRect();
        const b = document.getElementById('bubble').getBoundingClientRect();
        return { x: Math.round(window.screenX + r.left), y: Math.round(window.screenY + r.top),
                 rectLeft: Math.round(r.left), rectRight: Math.round(r.right),
                 bubbleLeft: Math.round(b.left), bubbleTop: Math.round(b.top), vp: innerWidth };
      })()`);

      await js('window.__petTest.memoOpen()');
      await wait(800);
      const bOpen = win.getBounds();
      const geo = await js(`(() => {
        const r = document.getElementById('pet').getBoundingClientRect();
        const m = document.getElementById('memo').getBoundingClientRect();
        const s = document.querySelector('.scene');
        return { petX: Math.round(window.screenX + r.left), petY: Math.round(window.screenY + r.top),
                 rectLeft: Math.round(r.left), rectRight: Math.round(r.right), screenX: window.screenX,
                 panelLeft: Math.round(m.left), panelRight: Math.round(m.right),
                 panelTop: Math.round(m.top), panelBottom: Math.round(m.bottom),
                 panelW: Math.round(m.width),
                 cols: getComputedStyle(s).gridTemplateColumns,
                 bubbleLeft: Math.round(document.getElementById('bubble').getBoundingClientRect().left),
                 bubbleRight: Math.round(document.getElementById('bubble').getBoundingClientRect().right),
                 petRectW: Math.round(r.width), vp: [window.innerWidth, window.innerHeight],
                 sceneClass: s.className };
      })()`);
      logInput({ src: 'selftest', type: 'pet-after',
        detail: `展开态：窗口=${bOpen.x}+${bOpen.width} 桌宠 rect=[${geo.rectLeft},${geo.rectRight}] → 屏幕 x=${geo.petX}`
          + `｜面板 rect=[${geo.panelLeft},${geo.panelRight}] 气泡左=${geo.bubbleLeft} 视口=${geo.vp[0]}` });
      const maskOpenState = clickThrough.getState();

      // 第 27 轮起：展开态比收起态**多一条面板列**（气泡列 + 面板列 + 桌宠列），
      // 窗口右边界不动、只往左长 → 桌宠不动。所以断言改成"右边界不变 + 面板在窗口内完整显示 + 多出来的宽度正好是面板列"。
      push('面板展开时窗口变宽（多出一条面板列，右边界不动）',
        bOpen.width > bClosed.width + 200 && Math.abs((bOpen.x + bOpen.width) - (bClosed.x + bClosed.width)) <= 2,
        `${bClosed.width}x${bClosed.height}@右${bClosed.x + bClosed.width} → ${bOpen.width}x${bOpen.height}@右${bOpen.x + bOpen.width}`
        + `（设计 收起 ${closedWidth()} = 桌宠 ${PET_COL} + 气泡列 ${BUBBLE_COL}；展开 ${openWidth()} 再多一条面板列 ${panelWinW}）`);
      // ⚠️ 第 29 轮按主人反馈改了：面板**不再钉在窗口最左边**，而是**紧贴她的左边**
      //    （原话："面板飞到左边去了，紧贴人物左边不重合就行"）。
      //    所以这里量的是"面板右边界 vs 她左边界"的间隙：要小（贴着她）但不能重叠（< 0）。
      push('面板紧贴她的左边（不重叠、也不飞到窗口最左边）', (() => {
        const gap = geo.rectLeft - geo.panelRight;        // 她左边界 - 面板右边界
        return gap >= -2 && gap <= 20
          && geo.rectRight >= geo.vp[0] - 3 && geo.rectRight <= geo.vp[0] + 3
          && geo.bubbleLeft >= geo.panelRight - 1 && geo.bubbleLeft >= 0 && geo.bubbleRight <= geo.vp[0] + 3;
      })(), `面板 x=[${geo.panelLeft},${geo.panelRight}]，她左边界=${geo.rectLeft} → 间隙=${geo.rectLeft - geo.panelRight}px（贴着她、不重叠）`
        + `；她 rect=[${geo.rectLeft},${geo.rectRight}] 宽=${geo.petRectW}（贴右，窗口宽 ${geo.vp[0]}）`
        + `；气泡=[${geo.bubbleLeft},${geo.bubbleRight}]`);
      // ★ 主人明确要求：点击后是"在右边生成面板"，人物本身不该移动
      const petMoved = Math.max(Math.abs(geo.petX - petScreenBefore.x), Math.abs(geo.petY - petScreenBefore.y));
      // 布局取证：一行看清"网格列 + 各元素矩形"（排查人物/气泡被挤偏时不用猜）
      {
        const lp = await js('window.__petTest.layoutProbe()');
        logInput({ src: 'selftest', type: 'layout',
          detail: `视口=${lp.vp} 列=[${lp.cols}] scene=[${lp.scene}] --bubble-w=${lp.bubbleVar} --sprite-w=${lp.spriteVar} class=${lp.sceneClass}`
            + `｜子元素=${JSON.stringify(lp.kids)}｜memo样式=${JSON.stringify(lp.memoStyle)}` });
      }
      push('★面板展开时桌宠屏幕位置不动（主人要求）', petMoved <= 4,
        `桌宠屏幕位置 (${petScreenBefore.x},${petScreenBefore.y}) → (${geo.petX},${geo.petY})，偏移 ${petMoved}px`);
      // 气泡要跟着她走：收起时在她左上角，面板打开后跟着她挪到右上角（不是被丢在窗口角落）
      const bubbleMoved = Math.abs(geo.bubbleLeft - petScreenBefore.bubbleLeft);
      const bubbleBesidePet = Math.abs(geo.bubbleLeft - (geo.rectRight + 8)) <= 14 || geo.bubbleLeft >= geo.panelRight - 1;
      push('气泡跟着人物走：收起在她左上角 → 面板打开后挪到她右上角（依旧贴着她）',
        bubbleMoved > 100 && bubbleBesidePet && geo.bubbleLeft >= 0,
        `气泡左边界 ${petScreenBefore.bubbleLeft} → ${geo.bubbleLeft}（人物右边界 ${geo.rectRight}，面板右边界 ${geo.panelRight}）`
        + `；也就是从"她左上角"换到"她右上角"，不是丢在窗口角落`);
      push('面板完整落在窗口内（不被裁掉）', geo.panelLeft >= 0 && geo.panelRight <= geo.vp[0] && geo.panelW >= 280,
        `面板 x=[${geo.panelLeft},${geo.panelRight}] 宽=${geo.panelW} 视口宽=${geo.vp[0]}`);
      push('窗口变宽后仍在工作区内', (() => {
        const wa = screen.getPrimaryDisplay().workArea;
        return bOpen.x >= wa.x && bOpen.y >= wa.y &&
          bOpen.x + bOpen.width <= wa.x + wa.width && bOpen.y + bOpen.height <= wa.y + wa.height;
      })(), `bounds=${bOpen.x},${bOpen.y},${bOpen.width},${bOpen.height} scene=${geo.sceneClass}`);
      push('面板展开后掩码已重算（实体范围跟上新尺寸）',
        maskOpenState.maskReady === true && (maskOpenState.stats.maskCoverage || 0) > 0.03,
        `实体占比=${maskOpenState.stats.maskCoverage} bbox=${JSON.stringify(maskOpenState.stats.maskBbox)}`);

      report.memo = { opened, withTasks, afterDone, full };

      // ---------- 播放速度（主人用临时滑条定为 0.49×，已固化进清单） ----------
      {
        const st = await js('window.__petTest.state()');
        const delays = st.sprite.loadedDelays || {};
        const groups = Object.keys(delays);
        const allDelays = groups.flatMap((g) => delays[g]);
        const uniq = [...new Set(allDelays)];
        // 0.49× 按 100ms 基准换算 = 204ms/帧
        const expected = Math.round(100 / 0.49);
        push('帧延时已按主人定的速度固化（0.49× → 约 204ms/帧）',
          uniq.length === 1 && Math.abs(uniq[0] - expected) <= 2,
          `实测每帧延时=${uniq.join('/')}ms（期望 ${expected}ms = 100ms ÷ 0.49）；` +
          `动作组=${groups.join(', ')}；一轮 idle ≈ ${(uniq[0] * (delays.idle || []).length / 1000).toFixed(2)} 秒`);
        push('调速滑条已删除（临时模块清理干净）',
          (await js('!!document.getElementById("speedSlider")')) === false
          && (await js('!!document.getElementById("speedRow")')) === false
          && (await js('typeof window.__petTest.setSpeed')) === 'undefined',
          `#speedSlider 存在=false；#speedRow 存在=false；__petTest.setSpeed 已移除`);
      }

      // ---------- 关闭方式（放在最后：关闭动作会隐藏面板，会干扰上面的测量） ----------
      // 1) 点面板内部 → 不应关闭
      await js('window.__petTest.memoOpen()');
      await wait(600);
      await js(`(() => { const el = document.getElementById('memoList');
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); })()`);
      await wait(250);
      const afterInside = await js('window.__petTest.memoSnapshot()');
      push('点面板内部不会关闭', afterInside.open === true, `点 memoList 后 open=${afterInside.open}`);
      // 2) 点面板外的窗口空白区 → 应关闭
      await js(`(() => { document.documentElement.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); })()`);
      await wait(800);
      const afterOutside = await js('window.__petTest.memoSnapshot()');
      push('点面板外的空白区 → 自动关闭',
        afterOutside.open === false && afterOutside.panelVisible === false,
        `点窗口空白后 open=${afterOutside.open} visible=${afterOutside.panelVisible}`);
      // 3) 鼠标离开整个窗口（主进程探测到）→ 应关闭
      await js('window.__petTest.memoOpen()');
      await wait(700);
      const reopened = await js('window.__petTest.memoSnapshot()');
      win.webContents.send('pet:pointer-outside');
      await wait(800);
      const afterLeave = await js('window.__petTest.memoSnapshot()');
      push('鼠标移出窗口（穿透态）→ 自动关闭',
        reopened.open === true && afterLeave.open === false,
        `重开后 open=${reopened.open} → 收到"鼠标已离开窗口"通知后 open=${afterLeave.open}`);

      await js('window.__petTest.memoClear()');
      await js('window.__petTest.memoClose()');
      await wait(900); // 等窗口缩回、掩码重算完成，否则后面的交互测试会点到面板上
      const settled = await js('window.__petTest.memoSnapshot()');
      push('面板收起后不再遮挡桌宠（测试隔离）', settled.open === false && settled.panelVisible === false,
        `open=${settled.open} visible=${settled.panelVisible}；窗口=${win.getBounds().width}x${win.getBounds().height}`);
    }

    // ---------- 鼠标穿透断言 ----------
    const cs = clickThrough.getState();
    const maskStats = cs.stats;
    push('穿透掩码已生成', cs.maskReady === true, `maskCoverage=${maskStats.maskCoverage} 物理=${maskStats.maskPhysical}`);
    // 阈值放宽到 0.03：无素材时画的是"空位提示"（一个淡色环），实体面积本来就小；
    // 真正要防的是"整窗都被判为实体"（那样穿透就失效了）。
    push('掩码只覆盖实体（不是整块窗口）', maskStats.maskCoverage > 0.03 && maskStats.maskCoverage < 0.75,
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

    // 取窗口内几个点的屏幕坐标。
    // 注意：不能假定"窗口正中心一定是实体"——空位提示是个环，中心本来就是空气。
    // 所以让掩码模块精确吐出一个实体像素的屏幕坐标，再用它验证命中判定。
    const rect = win.getBounds();
    const solid = clickThrough.findSolidPoint();
    const tCenter = solid
      ? clickThrough.testPoint(solid.screenX, solid.screenY)
      : clickThrough.testPoint(rect.x + Math.round(rect.width / 2), rect.y + Math.round(rect.height / 2));
    const tTL = clickThrough.testPoint(rect.x + 2, rect.y + 2);
    const tBR = clickThrough.testPoint(rect.x + rect.width - 3, rect.y + rect.height - 3);
    const tOutside = clickThrough.testPoint(rect.x - 50, rect.y - 50);

    push('掩码里存在实体像素', !!solid,
      solid ? `实体像素位于掩码(${solid.maskX},${solid.maskY}) → 窗口内逻辑坐标(${solid.logicalX},${solid.logicalY})`
            : '掩码里一个实体像素都没有 → 鼠标事件会全部穿透，点不到桌宠');
    push('实体区域命中（可点可拖）', tCenter.inside === true && tCenter.hit === true,
      solid ? `取样自掩码实体点(${solid.logicalX},${solid.logicalY}) hit=${tCenter.hit}` : `无实体点，回退中心取样 hit=${tCenter.hit}`);
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

    console.log('\n===== 桌宠自检报告 =====');
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
  const trace = (tag) => {
    if (!win || win.isDestroyed()) { boundsTrace.push(`${tag}=窗口已关闭`); return null; }
    const b = win.getBounds();
    boundsTrace.push(`${tag}=${b.width}x${b.height}`);
    return b;
  };
  trace('交互开始');

  await js('window.__petTest.click()');
  await wait(180);
  let s = await js('window.__petTest.state()');
  // ---------- 攻击面 1：左键点击（已改为待办面板） ----------
  await js('window.__petTest.memoClose()');
  await wait(600);
  const beforeClickPanel = await js('window.__petTest.memoSnapshot()');
  await js('window.__petTest.click()');
  await wait(400);
  const afterClickPanel = await js('window.__petTest.memoSnapshot()');
  push('点击桌宠打开待办面板', afterClickPanel.open === true && afterClickPanel.panelVisible === true,
    `before open=${beforeClickPanel.open} → after open=${afterClickPanel.open} visible=${afterClickPanel.panelVisible}`);
  await js('window.__petTest.memoClose()');
  await wait(800);

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
  // 取样点从角色位置动态算（不能写死坐标：面板展开时窗口尺寸和角色位置都会变）
  const probe = await js(`(() => {
    const r = document.getElementById('pet').getBoundingClientRect();
    return {
      center: [Math.round(r.left + r.width / 2), Math.round(r.top + Math.min(40, r.height / 2))],
      air: [2, 2],
      petRect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    };
  })()`);
  const hitOnPet = await js(`window.__petTest.probeHit(${probe.center[0]}, ${probe.center[1]})`);
  const hitOnAir = await js(`window.__petTest.probeHit(${probe.air[0]}, ${probe.air[1]})`);
  push('渲染层判定：角色上=命中实体', hitOnPet.hit === true,
    `取样(${probe.center.join(',')}) hit=${hitOnPet.hit} element=${hitOnPet.element} petRect=${JSON.stringify(probe.petRect)}`);
  push('渲染层判定：留白处=空气', hitOnAir.hit === false, `取样(${probe.air.join(',')}) hit=${hitOnAir.hit} element=${hitOnAir.element}`);

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

  // ---------- 真实事件链：左键已改为"展开待办面板" ----------
  const memoBeforeClick = await js('window.__petTest.memoSnapshot()');
  const realClick = await js('window.__petTest.realClick()');
  trace('realClick后');
  await wait(300);
  const memoAfterClick = await js('window.__petTest.memoSnapshot()');
  push('真实点击链(mousedown→mouseup→click)触发 click',
    memoAfterClick.opens + memoAfterClick.closes > memoBeforeClick.opens + memoBeforeClick.closes,
    `面板 开/关 次数 ${memoBeforeClick.opens}/${memoBeforeClick.closes} → ${memoAfterClick.opens}/${memoAfterClick.closes}`);
  push('左键点击＝展开待办面板（替代原随机台词）',
    memoAfterClick.open === true && memoAfterClick.panelVisible === true,
    `open=${memoAfterClick.open} visible=${memoAfterClick.panelVisible}`);
  push('快速点击后未卡在拖拽态（race 回归断言）', realClick.dragging === false,
    `点击瞬间 dragging=${realClick.dragging}`);
  // 收起面板（等窗口缩回），避免后续交互断言点到面板上
  await js('window.__petTest.memoClose()');
  await wait(800);
  const memoClosedNow = await js('window.__petTest.memoSnapshot()');
  push('收起面板后桌宠恢复可交互', memoClosedNow.open === false && memoClosedNow.panelVisible === false,
    `open=${memoClosedNow.open} 窗口=${win.getBounds().width}x${win.getBounds().height}`);

  // ---------- 右键菜单 ----------
  const menuBefore = menuLog.opened;
  const realMenu = await js('window.__petTest.realContextMenu()');
  trace('realContextMenu后');
  await wait(150);
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
  await wait(250);
  const memoAfterJitter = await js('window.__petTest.memoSnapshot()');
  push('微抖动点击(±3px)仍能触发面板（根因①回归）',
    jitterClick.clickDelta === 1 && memoAfterJitter.open === true,
    `click +${jitterClick.clickDelta}，面板 open=${memoAfterJitter.open}`);
  await js('window.__petTest.memoClose()');
  await wait(800);

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

    // 描边：数值已按主人调好的固化（0.25px / 62%），调试横条已拆掉
    {
      const olState = await js('window.__petTest.state()');
      const ol = (olState.sprite && olState.sprite.outline) || {};
      // ① 固化值 + 调试横条/入口都拆干净了（跟当初调速滑条一个流程）
      const leftovers = await js(`(() => ({
        row: !!document.getElementById('outlineRow'),
        w: !!document.getElementById('outlineWidth'),
        d: !!document.getElementById('outlineDepth'),
        setter: typeof window.__petTest.setOutline,
      }))()`);
      push('描边参数已固化（粗细 0.25px / 深浅 62% / 线色 rgb(97,97,97)）',
        Math.abs(ol.width - 0.25) < 0.001 && ol.depth === 62 && ol.color === 'rgb(97,97,97)',
        `粗细=${ol.width}px 深浅=${ol.depth}% 线色=${ol.color} 外轮廓=${ol.ring}px`);
      push('描边调试横条已拆除（临时模块清理干净）',
        leftovers.row === false && leftovers.w === false && leftovers.d === false && leftovers.setter === 'undefined',
        `#outlineRow=${leftovers.row} #outlineWidth=${leftovers.w} #outlineDepth=${leftovers.d}`
        + ` __petTest.setOutline=${leftovers.setter}`);
      // ② 部件线掩码（头发/眉毛/手/腿脚）已经接进来了
      push('部件描边掩码已接入（头发/眉毛/手/裙子外层/腿脚）',
        (ol.groupsWithEdges || []).length >= 3,
        `带掩码的动作组=[${(ol.groupsWithEdges || []).join(', ')}]；外轮廓=${ol.ring}px；`
        + `已缓存掩码层=${ol.masks} 剪影=${ol.silhouettes}`);
      // ③ 外轮廓像素取证：取样点最外侧必须是当前线色（颜色从状态里读，不写死）
      const lc = (ol.color || 'rgb(97,97,97)').match(/\d+/g).map(Number);
      const probe = await js(`(() => {
        const c = document.getElementById('sprite');
        if (!c) return { hits: 0, samples: [], size: '无' };
        const g = c.getContext('2d'), W = c.width, H = c.height;
        const d = g.getImageData(0, 0, W, H).data;
        const at = (x, y) => (y * W + x) * 4;
        const LR = ${lc[0]}, LG = ${lc[1]}, LB = ${lc[2]};
        let hits = 0; const samples = [];
        for (let y = 0; y < H; y++) {
          for (let x = 10; x < W - 3; x++) {
            const i = at(x, y), j = at(x + 3, y), k = at(x - 8, y);
            if (d[i + 3] < 200) continue;
            if (d[j + 3] > 20) continue;
            if (d[k + 3] < 200) continue;
            const outOk = Math.abs(d[i] - LR) <= 26 && Math.abs(d[i + 1] - LG) <= 26 && Math.abs(d[i + 2] - LB) <= 26;
            const inLum = d[k] * 0.299 + d[k + 1] * 0.587 + d[k + 2] * 0.114;
            if (!outOk || inLum < 150) continue;   // 最外是线色、内侧原本是亮色（不是原画自带的黑边）
            hits++; if (samples.length < 4) samples.push(x + ',' + y);
          }
        }
        return { hits, samples, size: W + 'x' + H };
      })()`);
      push('每一帧都套用描边，且描边真的画在轮廓上（画布像素取证）',
        ol.width > 0 && probe.hits >= 8,
        `描边=${ol.color} 粗细=${ol.width}px 外轮廓=${ol.ring}px；`
        + `画布 ${probe.size} 上"亮色轮廓 + 外侧描边"的取样点 ${probe.hits} 个（例：${(probe.samples || []).join(' / ')}）`);
    }

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
  await wait(150);
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
  const hasLabel = (s) => labels.some((l) => l.includes(s));
  push('菜单项符合本轮设计（开心 / 摸头 / 安静一会儿 / 设置 / 回到底部右侧 / 开发者工具 / 退出）',
    labels.length === 8 && hasLabel('开心') && hasLabel('摸头') && hasLabel('安静一会儿') && hasLabel('设置')
    && hasLabel('回到底部右侧') && hasLabel('开发者工具') && hasLabel('退出'),
    `共 ${labels.length} 项: ${labels.join(' / ')}`);
  push('已下架的菜单项不再出现（永远置顶 / 喂白饭 / 让她说句话）',
    !hasLabel('永远置顶') && !hasLabel('喂白饭') && !hasLabel('让她说句话'),
    `模板里没有这三项 → ${labels.join(' / ')}`);
  const clickables = tpl.filter((i) => typeof i.click === 'function').length;
  // 「有标题、但不可点」的项 = 标题项（enabled:false）。分隔线没标题，不参与。
  const titleItems = tpl.filter((i) => i.label && i.enabled === false).length;
  // ⚠️ 第 32 轮加了「安静一会儿」→ 原来那句 `clickables === 6` 必须跟着动。
  //    这就是"改设计要改断言"：留旧数字会红，改成 `>= 6` 又会丢掉"漏绑一个动作"的检测力，
  //    所以改成按菜单结构算（每个非标题的带标签项都必须绑到函数）。
  const unbound = tpl.filter((i) => i.label && i.enabled !== false && typeof i.click !== 'function').map((i) => i.label);
  push('菜单项都绑定了动作', unbound.length === 0 && clickables === labels.length - titleItems,
    `可点击项 ${clickables} = 带标题项 ${labels.length} − 标题项 ${titleItems}；没绑动作的=${unbound.length ? unbound.join('/') : '无'}`);

  // 兜底入口：Ctrl+M（不依赖鼠标，万一物理右键进不来也有办法开菜单）
  // 注意：面板打开时输入框会接收键盘输入并 stopPropagation（避免打字误触全局快捷键），
  //       所以这条要先收起面板再测。
  await js('window.__petTest.memoClose()');
  await wait(700);
  const kbBefore = menuLog.opened;
  const kb = await js('window.__petTest.keyboardMenu()');
  await wait(150);
  push('Ctrl+M 兜底入口可用（面板收起时）', kb.from === 'keyboard' && menuLog.opened === kbBefore + 1,
    `来源=${kb.from} 菜单次数 ${kbBefore} → ${menuLog.opened}`);

  // 面板打开时，键盘输入应被面板接管（不能误触全局快捷键）
  await js('window.__petTest.memoOpen()');
  await wait(600);
  const menuBeforeInPanel = menuLog.opened;
  const kbInPanel = await js('window.__petTest.keyboardMenu(true)');
  await wait(150);
  const memoStillOpen = await js('window.__petTest.memoSnapshot()');
  push('面板打开时键盘输入被输入框接管（不误触全局菜单）',
    kbInPanel.delta === 0 && kbInPanel.dispatchedOn === 'memoInput' &&
    menuLog.opened === menuBeforeInPanel && memoStillOpen.open === true,
    `从 ${kbInPanel.dispatchedOn} 派发的按键未触发菜单（计数增量 ${kbInPanel.delta}，主进程菜单次数保持 ${menuLog.opened}）；面板仍展开=${memoStillOpen.open}`);
  await js('window.__petTest.memoClose()');
  await wait(700);

  // 真机右键诊断快照（主人若再遇到右键无效，这个计数能告诉人家事件卡在哪一层）
  const diagSnap = await js('window.__petRightDiag ? ({...window.__petRightDiag}) : null');

  // 交互中窗口应保持稳定
  const b2 = trace('全部交互后');
  push('交互后窗口未跑位', Math.abs(b2.width - closedWidth()) <= 6 && Math.abs(b2.height - WIN_H) <= 6 && win.isVisible(),
    `bounds=${b2.width}x${b2.height}（设计 ${closedWidth()}x${WIN_H}）visible=${win.isVisible()}`);

  // ---------- 鼠标靠近（主人 2026-09-27 定的规矩：**必须悬停 0.3 秒才播触碰动画**） ----------
  {
    const hoverBefore = await js('window.__petTest.state()');
    const spB = hoverBefore.sprite || {};
    if (spB.available && (spB.groups || []).includes('hover')) {
      const SOLID = await js('window.__petTest.solidPoint()');   // 她身上真画了东西的点
      const r = { x: SOLID && SOLID.ok ? SOLID.clientX : 0, y: SOLID && SOLID.ok ? SOLID.clientY : 0 };
      // 先移出（确保从"离开"状态开始，避免初始化时鼠标恰好已在角色上导致基线不准）
      const outPos = await js(`(() => { const sp = window.__petTest.emptyPoint ? window.__petTest.emptyPoint() : null;
        const b = document.getElementById('sprite').getBoundingClientRect();
        return sp && sp.ok ? { x: sp.clientX, y: sp.clientY }
          : { x: Math.max(0, Math.round(b.left - 20)), y: Math.max(0, Math.round(b.top)) }; })()`);
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${outPos.x}, clientY: ${outPos.y} }))`);
      await wait(300);
      const out0 = await js('window.__petTest.state()');

      // ① 只悬停 150ms（不到 0.3 秒）→ **不许**播「靠近」
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${r.x}, clientY: ${r.y} }))`);
      await wait(150);
      const early = await js('window.__petTest.state()');
      push('鼠标刚靠近（不到 0.3 秒）**不播**触碰动画（鼠标一扫而过不打扰她）',
        early.sprite.hovering === false
        && (!early.sprite.timeline || early.sprite.timeline.group === early.sprite.baseGroup)
        && early.sprite.hoverEnters === out0.sprite.hoverEnters,
        `悬停 200ms 时：hovering=${early.sprite.hovering} 当前动作=${early.sprite.timeline ? early.sprite.timeline.group : 'null'}`
        + ` 待机=${early.sprite.baseGroup} enters=${early.sprite.hoverEnters}（基线 ${out0.sprite.hoverEnters}）`
        + ` 定时器等待中=${early.sprite.hoverDelay ? early.sprite.hoverDelay.waiting : '?'}`);

      // ② 停够 0.3 秒 → 播「靠近」
      await wait(300);   // 150 + 300 = 450ms > 300ms
      const inState = await js('window.__petTest.state()');
      push('悬停满 0.3 秒 → 切到「靠近」动作',
        inState.sprite.hovering === true && inState.sprite.hoverEnters === out0.sprite.hoverEnters + 1
        && inState.sprite.timeline && inState.sprite.timeline.group === 'hover'
        && inState.sprite.hoverDelay && inState.sprite.hoverDelay.delays >= 1,
        `移出基线 enters=${out0.sprite.hoverEnters} → 悬停满后 ${inState.sprite.hoverEnters}；`
        + `hovering=${inState.sprite.hovering} 当前动作=${inState.sprite.timeline ? inState.sprite.timeline.group : 'null'}`
        + ` 延时设置=${inState.sprite.hoverDelay ? inState.sprite.hoverDelay.ms : '?'}ms`
        + ` 真正触发次数=${inState.sprite.hoverDelay ? inState.sprite.hoverDelay.delays : '?'}`);

      // ③ 悬停中途移开 → 作废（不播）+ 立刻回待机
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${outPos.x}, clientY: ${outPos.y} }))`);
      await wait(300);
      const out1 = await js('window.__petTest.state()');
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${r.x}, clientY: ${r.y} }))`);
      await wait(150);
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${outPos.x}, clientY: ${outPos.y} }))`);
      await wait(300);
      const aborted = await js('window.__petTest.state()');
      push('悬停没满 0.3 秒就移开 → 不播「靠近」，立刻回待机',
        aborted.sprite.hovering === false
        && aborted.sprite.timeline && aborted.sprite.timeline.group === aborted.sprite.baseGroup
        && aborted.sprite.hoverDelay && aborted.sprite.hoverDelay.cancels >= 1,
        `第一次移出后：hovering=${out1.sprite.hovering}；`
        + `"进 200ms 就退"之后：hovering=${aborted.sprite.hovering}`
        + ` 当前动作=${aborted.sprite.timeline ? aborted.sprite.timeline.group : 'null'}`
        + ` 中途作废次数=${aborted.sprite.hoverDelay ? aborted.sprite.hoverDelay.cancels : '?'}`);

      // ④ 再停够 0.3 秒 → 动作回来（确认"作废"之后还能正常触发）
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${r.x}, clientY: ${r.y} }))`);
      await wait(450);
      const again = await js('window.__petTest.state()');
      push('作废之后重新悬停 0.3 秒 → 「靠近」动作照常触发',
        again.sprite.hovering === true && again.sprite.timeline && again.sprite.timeline.group === 'hover',
        `hovering=${again.sprite.hovering} 当前动作=${again.sprite.timeline ? again.sprite.timeline.group : 'null'}`);

      // 趁「靠近」动作正显示着抓一张图：主人说过"白蝴蝶不要描"，这张就是给他核对用的
      {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(ARTIFACTS, 'shot-hover.png'), img.toPNG());
      }
      // 移出角色 → 立刻回待机
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${outPos.x}, clientY: ${outPos.y} }))`);
      await wait(400);
      const outState = await js('window.__petTest.state()');
      push('鼠标移出 → 立刻回到待机动作',
        outState.sprite.hovering === false && outState.sprite.timeline && outState.sprite.timeline.group === outState.sprite.baseGroup,
        `hovering=${outState.sprite.hovering} 当前动作=${outState.sprite.timeline ? outState.sprite.timeline.group : 'null'} 待机=${outState.sprite.baseGroup} 离开次数 ${outState.sprite.hoverExits}`);
    } else {
      push('鼠标靠近动作可触发（当前无 hover 素材，跳过）', true, `现有动作: ${(spB.groups || []).join(', ') || '无'}`);
    }
  }

  // ---------- 菜单动作 → 交互动作组（主人把 1/5/6 分给"交互"） ----------
  {
    // 统一的"鼠标移出/移入"动作：**动态算坐标**
    // ⚠️ 第 27 轮把"靠近"判定从矩形改成逐像素之后，移出点不能再随便取（比如 (1,0) 在细长构图下
    //    可能仍在角色身上）。OFF_POINT 由渲染层算：角色矩形内**没有实体像素**的那个角。
    const OFF_POINT = await js(`(() => {
      const sp = window.__petTest.emptyPoint ? window.__petTest.emptyPoint() : null;
      if (sp && sp.ok) return { x: sp.clientX, y: sp.clientY, why: '角色矩形内的空气点' };
      const b = document.getElementById('pet').getBoundingClientRect();
      return { x: Math.max(0, Math.round(b.left + 2)), y: Math.max(0, Math.round(b.top + 2)), why: '兜底：矩形左上角' };
    })()`);
    const hoverOut = async () => {
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${OFF_POINT.x}, clientY: ${OFF_POINT.y} }))`);
      await wait(260);
    };
    const hoverIn = async () => {
      // ⚠️ 必须移到**角色身上确实画了东西**的点：第 27 轮把"靠近"判定从矩形改成逐像素之后，
      //    矩形中心可能正好是空气（脸上的空隙），合成事件移到那儿就不再算"靠近"了。
      const p = await js('window.__petTest.solidPoint()');
      if (p && p.ok && p.selfCheck !== true) {
        // 自证失败 = 坐标映射有偏差（像素判定和 solidPoint 对不上），记一条免得以后查半天
        logInput({ src: 'selftest', type: 'solid-point', detail: `⚠️ 实体点自判失败：${JSON.stringify(p)}` });
      }
      if (!p || !p.ok) {
        const c = await js(`(() => { const b = document.getElementById('sprite').getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
        await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${c.x}, clientY: ${c.y} }))`);
        await wait(150);
        return;
      }
      await js(`window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: ${p.clientX}, clientY: ${p.clientY} }))`);
      // ⚠️ 主人 2026-09-27 定了"悬停 0.3 秒才播触碰动画"，所以这里必须等够 0.3 秒
      //    （原来只等 200ms，断言会因为"延时还没到"而红）
      await wait(450);
    };

    const before = await js('window.__petTest.state()');
    const spA = before.sprite || {};

    // ---------- 回归：鼠标移进她身上后，**往下 / 往右**移开也要回待机（主人 2026-09-25 反馈） ----------
    // 为什么单独测这两个方向：往左上移开时鼠标会离开整个窗口（渲染层能收到 mouseleave），
    // 而往下/往右移开会落在**窗口内的透明区**——那时窗口刚好切回穿透态，
    // mousemove 可能就此断掉，动作就卡在「靠近」的最后一帧上。
    if (spA.available && (spA.groups || []).includes('hover')) {
      const dirs = [
        { name: '往下', x: 'cx', y: 'belowBottom', desc: '角色下边界 +15px' },
        { name: '往右', x: 'leftMinus', y: 'cy', desc: '角色左边界 -15px（窗口内、且肯定在角色外）' },
      ];
      // 这一组要验的正是**兜底心跳**本身：先把事件路径"掐掉"（只设状态、不发 mousemove），
      // 再打开兜底，看它能不能靠"主动问鼠标在哪"把动作复原。
      // 这就是真机上的场景：鼠标移开后窗口切回穿透态，渲染层再也收不到 mousemove。
      //
      // ⚠️ 顺序坑（人家白红了两轮）：兜底心跳看的是**真鼠标**，而自检用的是合成事件
      //    （真鼠标在屏幕别处）→ 一打开兜底，它就会把"刚设好的 hover"立刻改回待机。
      //    所以"移入后 hovering=true"这个观测必须在**打开兜底之前**拿到。
      const preHover = await (async () => { await hoverIn(); return js('window.__petTest.state()'); })();
      await hoverOut();
      await js('window.__petTest.setHoverWatchdog(true)');
      for (const d of dirs) {
        await hoverIn();
        const inNow = { sprite: { hovering: preHover.sprite.hovering } };   // 用兜底打开前的观测（见上）
        // 再往指定方向移开一点点（仍在窗口内）。
        // ⚠️ 这里**故意不发 mousemove**：模拟"穿透态下事件断了"，只让兜底心跳去发现。
        // ⚠️ 坐标口径要和主进程 getCursor 报的完全一致（都用 #pet 自身的矩形 + 窗口左上角），
        //    不然"移开点"会落在角色里，兜底判定永远 inside=true（人家第一版就是这么白跑的）。
        const pos = await js(`(() => {
          const sp = window.__petTest.solidPoint();
          const b = document.getElementById('pet').getBoundingClientRect();
          const cx = sp.ok ? sp.clientX : Math.round(b.left + b.width / 2);
          const cy = sp.ok ? sp.clientY : Math.round(b.top + b.height / 2);
          const sr = document.getElementById('sprite').getBoundingClientRect();
          const scene = document.querySelector('.scene');
          const vw = innerWidth, vh = innerHeight;
          // 往下：角色下边界 +15（夹在窗口内）；往右：改用"角色左边 -15" ——
          // 因为窗口右边界就贴着角色右边（就差 1px），往右根本出不去，
          // 用左边同样能验证"横向移开"，而且是真·角色外。
          const belowBottom = Math.min(vh - 1, Math.round(b.bottom + 15));
          const leftMinus = Math.max(0, Math.round(b.left - 15));
          const rightSide = Math.min(vw - 1, Math.round(b.right + 15));
          return { cx, cy, belowBottom, leftMinus, rightSide, vw, vh,
                   paintedPixels: sp.painted || 0,
                   petRect: [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)] };
        })()`);
        const tx = d.x === 'leftMinus' ? pos.leftMinus : pos.cx;
        const ty = d.y === 'belowBottom' ? pos.belowBottom : pos.cy;
        // 把"主进程看到的鼠标位置"换成移开后的点（窗口内坐标，自检专用）
        win.__fakeCursor = { x: tx, y: ty };
        await wait(900);   // 兜底心跳 250ms 一次，给足 3 次机会
        const st = await js('window.__petTest.state()');
        win.__fakeCursor = null;
        const wd = st.sprite.hoverWatchdog || {};
        push(`鼠标靠近后${d.name}移开 → 回到待机动作（事件断了也有兜底）`,
          inNow.sprite.hovering === true && st.sprite.hovering === false
          && st.sprite.timeline && st.sprite.timeline.group === st.sprite.baseGroup && (wd.fixes || 0) >= 1,
          `移入点=(${pos.cx},${pos.cy})（角色身上的实体像素）→ 移入后 hovering=${inNow.sprite.hovering}；`
          + `移开点=(${tx},${ty})（${d.desc}，且**故意不发 mousemove**）→ hovering=${st.sprite.hovering}`
          + ` 当前动作=${st.sprite.timeline ? st.sprite.timeline.group : 'null'} 待机=${st.sprite.baseGroup}`
          + `；兜底心跳 运行${wd.ticks || 0}次 修正${wd.fixes || 0}次`
          + `（逐像素位图 ${pos.paintedPixels || '?'} 个实体像素）`);
      }
      await js('window.__petTest.setHoverWatchdog(false)');
      await hoverOut();
    }
    if (spA.available && (spA.groups || []).includes('interact')) {
      await hoverOut();
      const outBase = await js('window.__petTest.state()');
      // 摸头：立刻检查（交互组只有 3 帧 ≈360ms，等太久它会已经播完回待机 → 断言不稳定）
      win.webContents.send('pet:action', 'headpat');
      await wait(120);
      const afterPat = await js('window.__petTest.state()');
      push('右键摸头 → 播放「交互」动作组',
        afterPat.sprite.timeline && afterPat.sprite.timeline.group === 'interact'
        && afterPat.bubbleShown === true,
        `当前动作=${afterPat.sprite.timeline ? afterPat.sprite.timeline.group : 'null'}`
        + ` 气泡="${afterPat.bubbleText}" 可见=${afterPat.bubbleShown}`);
      // 交互动作是"播一次"，等它播完应自动回待机
      await wait(1600);
      const afterDone = await js('window.__petTest.state()');
      push('交互动作播完自动回待机',
        afterDone.sprite.timeline && afterDone.sprite.timeline.group === afterDone.sprite.baseGroup,
        `当前动作=${afterDone.sprite.timeline ? afterDone.sprite.timeline.group : 'null'} 待机=${afterDone.sprite.baseGroup}`);
      // 顺带验证"读不到中间态"的补救：用逐帧采样确认 interact 确实播过
      win.webContents.send('pet:action', 'headpat');
      const seen = [];
      for (let i = 0; i < 6; i++) {
        await wait(80);
        const s = await js('window.__petTest.state()');
        seen.push(s.sprite.timeline ? s.sprite.timeline.group : '(停)');
      }
      push('逐帧采样确认摸头播放了「交互」组', seen.includes('interact'),
        `80ms 间隔采样 6 次: ${seen.join(' → ')}`);
      await wait(1200);
      // 「开心」= 一组循环动画（主人 2026-09-24 把待机动画换到了开心上），
      // 点一次进入"保持"（一直循环播），再点一次才退出
      await hoverOut();
      win.webContents.send('pet:action', 'happy');
      await wait(150);
      const afterHappy = await js('window.__petTest.state()');
      const happyTl = afterHappy.sprite.timeline || {};
      push('右键「开心」 → 播放专属「happy」素材组',
        happyTl.group === 'happy' && afterHappy.bubbleShown === true,
        `当前动作=${happyTl.group || 'null'} 气泡="${(afterHappy.bubbleText || '').slice(0, 20)}"`
        + ` 可用动作=[${(afterHappy.sprite.groups || []).join(', ')}]`);
      push('「开心」进入保持状态（poseGroup=happy，loop 循环不自动收尾）',
        afterHappy.sprite.poseGroup === 'happy' && happyTl.loop === true,
        `poseGroup=${afterHappy.sprite.poseGroup || 'null'} loop=${happyTl.loop}`);
      // 趁保持期间抓一张图：主人能直接看到「开心」素材在窗口里长什么样、多大
      // （人家看不见图时，"素材到底渲染成什么"只能靠这张自证）
      {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(ARTIFACTS, 'shot-happy.png'), img.toPNG());
        const hp = await js(`(() => {
          const c = document.getElementById('sprite');
          const r = c.getBoundingClientRect();
          return { w: c.width, h: c.height, cssW: Math.round(r.width), cssH: Math.round(r.height) };
        })()`);
        push('抓「开心」保持中的截图供主人目视确认',
          fs.existsSync(path.join(ARTIFACTS, 'shot-happy.png')) && hp.w > 0,
          `artifacts/shot-happy.png；画布 ${hp.w}x${hp.h}（CSS ${hp.cssW}x${hp.cssH}）`);
      }
      // ① 关键：等久一点也**不许自动退出**（原来 1 秒就回待机了，主人要的就是别退）
      await wait(2200);
      const stillHappy = await js('window.__petTest.state()');
      const stillGroup = (stillHappy.sprite.timeline || {}).group || null;
      push('保持动作不会自动退出（2.2 秒后仍在 happy）',
        stillGroup === 'happy' && stillHappy.sprite.poseGroup === 'happy',
        `当前动作=${stillGroup} poseGroup=${stillHappy.sprite.poseGroup || 'null'}`);
      // ② 鼠标划过她身上也不能把姿势顶掉（否则"保持"等于没做）
      await hoverIn();
      await wait(400);
      const hoveredDuring = await js('window.__petTest.state()');
      push('保持动作期间鼠标移到她身上也不会被「靠近」顶掉',
        ((hoveredDuring.sprite.timeline || {}).group) === 'happy',
        `当前动作=${(hoveredDuring.sprite.timeline || {}).group || 'null'} hovering=${hoveredDuring.sprite.hovering}`);
      await hoverOut();
      await wait(150);
      // ③ 主进程菜单要跟着打勾（勾选状态由渲染层回报）
      const happyItemOn = buildMenuTemplate().find((i) => i.label && i.label.includes('开心'));
      push('菜单「开心」是勾选项，且保持中显示为已勾选',
        happyItemOn && happyItemOn.type === 'checkbox' && happyItemOn.checked === true,
        `type=${happyItemOn && happyItemOn.type} checked=${happyItemOn && happyItemOn.checked}`);
      // ④ 再点一次 → 退出保持，回待机
      win.webContents.send('pet:action', 'happy');
      await wait(400);
      const afterOff = await js('window.__petTest.state()');
      const offGroup = (afterOff.sprite.timeline || {}).group || null;
      push('再点一次「开心」 → 退出保持，回到待机',
        afterOff.sprite.poseGroup === null && offGroup !== 'happy',
        `当前动作=${offGroup} poseGroup=${afterOff.sprite.poseGroup || 'null'} 待机=${afterOff.sprite.baseGroup}`);
      const happyItemOff = buildMenuTemplate().find((i) => i.label && i.label.includes('开心'));
      push('退出保持后菜单勾选也取消',
        happyItemOff && happyItemOff.checked === false,
        `checked=${happyItemOff && happyItemOff.checked}`);
      // 鼠标停在角色上时，交互播完的落点：应该是「靠近」或「待机」，**不能卡在交互上**
      // （这条断言原来写死"必须停在 hover"，但鼠标位置会受窗口位置影响，不稳定；
      //   它真正要保证的是"不会卡住 + 会回到可循环状态"，所以改成这个说法）
      await hoverIn();
      const hoveredNow = await js('window.__petTest.state()');
      win.webContents.send('pet:action', 'headpat');
      await wait(1800);
      const settled = await js('window.__petTest.state()');
      const settledGroup = settled.sprite.timeline ? settled.sprite.timeline.group : null;
      push('交互播完后回到可循环状态（不卡在交互上）',
        settledGroup === settled.sprite.baseGroup || settledGroup === 'hover',
        `hovering=${settled.sprite.hovering}（进入前=${hoveredNow.sprite.hovering}）`
        + ` 当前动作=${settledGroup} 待机=${settled.sprite.baseGroup}`
        + `（鼠标在角色上时停在 hover、不在时回 idle，两者都算正常）`);
      await hoverOut();
    } else {
      push('菜单动作 → 交互动作组可触发（当前无 interact 素材，跳过）', true,
        `现有动作: ${(spA.groups || []).join(', ') || '无'}`);
    }
  }

  // 测试收尾：把面板关掉并等窗口缩回，否则后面"窗口未跑位"会读到展开态的尺寸
  await js('window.__petTest.memoClose()');
  await wait(900);
  {
    const b = win.getBounds();
    push('全部交互测试结束后窗口回到设计尺寸',
      Math.abs(b.width - closedWidth()) <= 6 && Math.abs(b.height - WIN_H) <= 6,
      `bounds=${b.width}x${b.height} 设计=${closedWidth()}x${WIN_H}`);
  }

  // ---------- API 接入（第 25 轮） ----------
  // 这一组断言里**一条真实 API 调用都没有** —— 自检必须离线可跑，
  // 更不能拿主人的密钥去花钱、去撞限流。覆盖的点是"配没配得上、密钥会不会漏、
  // 各家错误有没有台词、界面这条路通不通"。
  {
    const cfgPath = apiConfig.getConfigPath();
    const cfgObj = apiConfig.load();
    push('API 设置存在用户数据目录（便携版与安装版共用同一份）',
      cfgPath.startsWith(app.getPath('userData')) && cfgPath.endsWith('api-config.json'),
      `${cfgPath}（默认地址=${cfgObj.baseUrl} 默认模型=${cfgObj.model}）`);

    // ★ 反向断言：密钥**绝不能**出现在渲染层能拿到的任何东西里
    const view = apiConfig.publicView(cfgObj);
    const serialized = JSON.stringify(view);
    push('密钥不会外泄：设置的安全视图里没有可用的密钥',
      view.apiKey === undefined && !('apiKey' in view)
      && (!cfgObj.apiKey ? view.maskedKey === '' : (view.maskedKey.includes('•') && !serialized.includes(cfgObj.apiKey))),
      `hasKey=${view.hasKey} maskedKey="${view.maskedKey}"（只在需要时才解密使用，从不发给渲染层）`);

    // ⚠️ 必须先把面板展开再量：面板 display:none 时 getBoundingClientRect 全是 0，
    //    断言会"因为元素不可见反而通过"（这种假绿最坑人，所以这里连尺寸一起查）。
    await js('window.__petTest.memoOpen()');
    await wait(700);
    const chatInputEl = await js(`(() => {
      const el = document.getElementById('chatInput');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const panel = document.getElementById('memo').getBoundingClientRect();
      return { tag: el.tagName, rect: { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
               placeholder: el.placeholder, maxLength: el.maxLength,
               inPanel: r.top >= panel.top - 1 && r.bottom <= panel.bottom + 1, inWindow: r.bottom <= innerHeight,
               panelBottom: Math.round(panel.bottom), winH: Math.round(innerHeight) };
    })()`);
    push('桌宠气泡那一侧有「和她说…」输入框（接 API 的入口在界面上）',
      !!chatInputEl && chatInputEl.inPanel === true && chatInputEl.inWindow === true
      && chatInputEl.rect.w > 100 && chatInputEl.rect.h >= 20 && /说句话/.test(chatInputEl.placeholder || ''),
      chatInputEl ? `${chatInputEl.tag} ${chatInputEl.rect.w}x${chatInputEl.rect.h} @(${chatInputEl.rect.left},${chatInputEl.rect.top})`
        + ` 提示语="${chatInputEl.placeholder}" 上限=${chatInputEl.maxLength} 字`
        + ` 在面板内=${chatInputEl.inPanel} 面板底=${chatInputEl.panelBottom} ≤ 窗口高=${chatInputEl.winH}` : '没找到 #chatInput');

    // 空消息不该发请求（省得白花主人的 token），而且必须"立刻返回"不卡界面
    const t0 = Date.now();
    const emptySend = await js('window.__petTest.chatSend("   ")');
    const emptyMs = Date.now() - t0;
    push('空消息不发送（不浪费主人的 token）',
      emptySend && emptySend.ok === false && emptySend.kind === 'empty' && emptyMs < 1500,
      `返回 ${JSON.stringify(emptySend)}，耗时 ${emptyMs}ms`);

    // 驱动一次真实发送：走的是渲染层那条路（回车 → 主进程 → 台词回来）。
    // 没配密钥时主进程会立刻用"还没拿到钥匙"那句兜住 —— 这一步**不会真的联网**。
    //
    // ⚠️ 先确认面板真的开着再打字：打包版启动比开发版慢（首帧多几百毫秒），
    //    实测偶发"面板还没展开就发消息"→ 面板矩形量出来是 [0,0]、
    //    "气泡在她右上方"那条断言会误报红（跑两次能复现一次）。这里补一次保险。
    {
      const opened = await js('window.__petTest.memoSnapshot()');
      if (!opened || opened.open !== true) {
        await js('window.__petTest.memoOpen()');
        await wait(700);
      }
    }
    const chatBox = await js(`(() => {
      const el = document.getElementById('chatInput');
      el.focus(); el.value = '自检：你在吗';
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { value: el.value };
    })()`);
    await wait(1600);
    const chatAfter = await js('window.__petTest.chatSnapshot()');
    const chatUnconfigured = !apiConfig.load().apiKey;
    push('对话这条路是通的（回车 → 主进程 → 台词回到气泡）',
      chatAfter.sends >= 1 && (chatUnconfigured
        ? (chatAfter.lastKind === 'noKey' && /钥匙/.test(chatAfter.lastText || ''))
        : (chatAfter.lastKind === 'ok' ? chatAfter.replies >= 1 : chatAfter.errors >= 1)),
      `输入框已清空=${chatBox.value === ''} 发送次数=${chatAfter.sends} 最近 kind=${chatAfter.lastKind}`
      + ` ${chatAfter.lastMs}ms 台词="${(chatAfter.lastText || '').slice(0, 30)}"`
      + (chatUnconfigured ? '（自检时没配密钥 → 走"还没拿到钥匙"这条兜底，不会真的联网）' : '（已配密钥 → 真发了一次）'));
    const bubbleAfterChat = await js('window.__petTest.state()');
    push('她说的话落在气泡里（气泡不空、在窗口内）',
      bubbleAfterChat.bubbleShown === true && (bubbleAfterChat.bubbleText || '').length > 2
      && bubbleAfterChat.bubbleInViewport === true,
      `气泡="${(bubbleAfterChat.bubbleText || '').slice(0, 30)}" 在窗口内=${bubbleAfterChat.bubbleInViewport}`);

    // ★ 主人 2026-09-27 定的规矩：**收起时气泡在她左上角，面板打开时气泡改到她右上角**
    //   （面板紧贴她左边，气泡落在她右边、依然贴着她）。
    //   这里量的是真实矩形：气泡与面板不许相交，而且气泡要在她右边。
    fs.writeFileSync(path.join(ARTIFACTS, 'shot-chat-split.png'), (await win.webContents.capturePage()).toPNG());
    const bl = bubbleAfterChat.bubbleLayout;
    const bubbleOnRightSide = !!bl && bl.bubble.left >= bl.panel.right - 1;
    push('面板打开时气泡在她右上方（面板在她左边、二者不重叠、气泡没被推出窗口）',
      !!bl && bl.chatting === true && bl.panel.width > 40 && bl.overlapsPanel === false
      && bubbleOnRightSide && bl.bubble.left >= 0 && bl.bubble.right <= bl.winW + 2,
      bl ? `面板 [${bl.panel.left},${bl.panel.right}]（侧=${bl.panelSide}） 气泡 [${bl.bubble.left},${bl.bubble.right}]`
        + ` 窗口宽=${bl.winW} 在面板右侧=${bubbleOnRightSide} 相交=${bl.overlapsPanel}`
        + ` 气泡在窗口内=${bl.bubble.left >= 0 && bl.bubble.right <= bl.winW + 2}`
      : '拿不到 bubbleLayout');

    // 长回复也得待在她右边、不压面板、不出窗口
    await js(`window.__petTest.sayLine('${'长'.repeat(56)}')`);
    await wait(500);
    const blLong = (await js('window.__petTest.state()')).bubbleLayout;
    push('长回复时气泡依然在她右上方、不压面板',
      !!blLong && blLong.overlapsPanel === false && blLong.bubble.left >= blLong.panel.right - 1
      && blLong.bubble.left >= 0 && blLong.bubble.right <= blLong.winW + 2,
      blLong ? `56 字回复：气泡 [${blLong.bubble.left},${blLong.bubble.right}] 面板 [${blLong.panel.left},${blLong.panel.right}]`
        + ` 间隙=${blLong.gap}px 相交=${blLong.overlapsPanel}` : '拿不到 bubbleLayout');

    // ★ 注意 classify 的签名是 classify(网络错误对象, HTTP 状态码, 响应正文)：
    //   上面 8 行测的是"错误分类器"本身（不联网），最后一行才是真发一次请求。
    // ★ 注意两种返回的形状不一样：classify() 给的是 { kind, line }（纯分类器），
    //   chat() 给的是 { ok, kind, text }（已经带上了台词）。这里统一取台词再比对。
    const cases = [
      ['没配密钥', await chatApi.chat({ ...cfgObj, apiKey: '' }, [{ role: 'user', content: 'hi' }]), 'noKey'],
      ['接口关了（设置里关掉）', await chatApi.chat({ ...cfgObj, apiKey: 'sk-selftest-not-real', enabled: false }, [{ role: 'user', content: 'hi' }]), 'disabled'],
      ['401/403 密钥不对', chatApi.classify(null, 401, ''), 'auth'],
      ['402 余额不足', chatApi.classify(null, 402, ''), 'quota'],
      ['429 请求太快', chatApi.classify(null, 429, ''), 'rate'],
      ['404 模型名写错', chatApi.classify(null, 404, ''), 'notfound'],
      ['500 对面服务器出错', chatApi.classify(null, 503, ''), 'server'],
      ['连不上（DNS 失败）', chatApi.classify({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND' }, 0, ''), 'network'],
    ];
    const lineOf = (r) => String((r && (r.text || r.line)) || '');
    const lost = cases.filter(([, r, kind]) => r.kind !== kind || !lineOf(r));
    const offline = await chatApi.chat({ ...cfgObj, apiKey: 'sk-selftest-not-real', baseUrl: 'http://127.0.0.1:1', model: 'x', timeoutMs: 3000 },
      [{ role: 'user', content: 'hi' }]);
    push('各种失败都有人话（8 类错误 + 真·连不上都翻译成台词）',
      lost.length === 0 && offline.ok === false && !!offline.text && ['network', 'timeout'].includes(offline.kind),
      lost.length ? `漏了: ${lost.map(([n]) => n).join(', ')}`
        : `8 类：${cases.map(([n, r]) => `${n}→"${lineOf(r)}"`).join(' ')}｜真连不上 kind=${offline.kind} "${offline.text}"`);

    const ready = !!(cfgObj.apiKey && cfgObj.baseUrl && cfgObj.model);
    push(ready ? 'API 已配置（真机可对话）' : 'API 未配置：桌宠照常跑，点她仍会说本地台词（不报错）',
      true,
      ready ? `地址=${cfgObj.baseUrl} 模型=${cfgObj.model}（真实调用请主人自己点一下试）`
        : `还没填密钥；失败台词示例："${chatApi.ERROR_LINES.noKey}"`);

    // 设置窗口是真窗口：自检里把它打开一次，确认"能加载、表单铺开、没有渲染报错"，
    // 然后抓一张图存到 artifacts（人家看不见图，主人可以自己点开看）
    try {
      const sw = openSettingsWindow('selftest');
      await new Promise((r) => sw.webContents.once('did-finish-load', r));
      await wait(1200);
      const form = await sw.webContents.executeJavaScript(`(() => {
        const v = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
        const b = document.getElementById('baseUrl');
        return { title: document.title, baseUrl: v('baseUrl'), model: v('model'), enabled: document.getElementById('enabled').checked,
                 keyEmpty: document.getElementById('apiKey').value === '', keyType: document.getElementById('apiKey').type,
                 presets: document.querySelectorAll('#presets button').length,
                 baseUrlW: b ? Math.round(b.getBoundingClientRect().width) : 0,
                 fitsNoScroll: document.body.scrollHeight <= innerHeight + 2,
                 buttons: !!(document.getElementById('save') && document.getElementById('test') && document.getElementById('openCfg')) };
      })()`);
      fs.writeFileSync(path.join(ARTIFACTS, 'shot-settings.png'), (await sw.webContents.capturePage()).toPNG());
      push('设置窗口能打开且表单铺开（截图 artifacts/shot-settings.png）',
        form.title.includes('设置') && form.baseUrl === cfgObj.baseUrl && form.model === cfgObj.model
        && form.presets >= 4 && form.baseUrlW > 200 && form.buttons === true && form.keyEmpty === true,
        `标题=${form.title} 地址框="${form.baseUrl}" 模型="${form.model}" 宽=${form.baseUrlW}px`
        + ` 预设=${form.presets} 个 密钥框为空=${form.keyEmpty} 类型=${form.keyType} 一次不用滚动=${form.fitsNoScroll}`);
      sw.destroy();
      await wait(400);
    } catch (err) {
      push('设置窗口能打开且表单铺开（截图 artifacts/shot-settings.png）', false,
        '打开失败: ' + (err && err.message));
    }
  }

  // ---------- 她的话（第 32 轮）：动作走模型 / 人格可调 / 空闲开口限频 ----------
  // 这一组同样**一条真实 API 调用都没有**：走模型那条路靠配置里的 mockReply 旁路
  // （同样跑完 chat() 的整条链路，只是不发网络请求 —— 见 lib/api-config.js 的注释）。
  {
    const cfgPath = apiConfig.getConfigPath();
    const realCfg = apiConfig.load();
    // ⚠️ 配置文件**可能还不存在**：只调 load() 不会创建它（只有 save() 才落盘）。
    //    第一版这里直接 readFileSync → 全新环境 / 隔离的自检目录上必崩（自检当场抓到）。
    //    所以：读不到就当它"本来就是空的"，收尾时把"不存在"这个事实也还原回去。
    let originalCfgText = null;
    try { originalCfgText = fs.readFileSync(cfgPath, 'utf8'); } catch { originalCfgText = null; }
    const restoreCfg = () => {
      if (originalCfgText === null) { try { fs.rmSync(cfgPath, { force: true }); } catch { /* 忽略 */ } }
      else fs.writeFileSync(cfgPath, originalCfgText, 'utf8');
      apiConfig.reloadCache();   // ★ 必须重读磁盘：load() 有缓存，save({}) 只会把旧缓存写回去
    };
    // 纯函数直接用 lib/action-lines.js 的实现（**不复制一份**：复制出来的副本会漂移，
    // 那样断言测的就是副本而不是真货 —— 这是"断言必须钉住真实现"的老规矩）
    const personaIsEmpty = actionLines.personaIsEmpty;
    const buildSystemPrompt = actionLines.buildSystemPrompt;
    const apiLinesDebugPrompt = (action) => {
      const c = apiConfig.load();
      return {
        system: actionLines.buildSystemPrompt({ persona: c.persona, legacyPrompt: c.systemPrompt, action }),
        messages: actionLines.buildActionMessages({ persona: c.persona, legacyPrompt: c.systemPrompt, action }),
      };
    };
    // 空闲状态的注入与观测：**直接调主进程里那份实现**（`pet:idle-state` 的处理器只是把它包了一层）。
    // 为什么不去绕 ipcMain 的内部结构：那是 Electron 私有字段，升级就可能改名 —— 那种依赖比不测还糟。
    // 通道本身的存在性由 app 启动时的 ipcMain.handle 注册保证（注册失败会立刻抛错）。
    const idleStateInject = (payload) => Promise.resolve(idleStateForTest(payload || {}));
    const writeCfg = (extra) => {
      // ★ 每次都从**磁盘当前值**出发，不能从块开头那份快照展开：
      //   否则中间设的密钥/人格会被后一次覆盖回旧值（第 32 轮实测：多条断言因此连环红，
      //   症状是 api_not_ready —— 看着像"新逻辑没生效"，实际是测试自己把配置抹掉了）。
      const cur = apiConfig.reloadCache();
      const merged = { ...cur, ...extra, persona: { ...cur.persona, ...((extra && extra.persona) || {}) } };
      const norm = apiConfig.normalize(merged);
      fs.writeFileSync(cfgPath, JSON.stringify(norm, null, 2), 'utf8');
      apiConfig.reloadCache();   // ★ load() 有缓存：只有重读磁盘，写进去的测试配置才真的生效
      return apiConfig.load();
    };
    try {
      // (a) 设置窗口里的新面板要真的长出来 —— 这里量的是**主进程最终拼出来的提示词**
      push('人格（五项）会进 system 提示词，气泡硬约束也跟着进',
        personaIsEmpty({}) === true
        && buildSystemPrompt({ persona: { identity: 'SELFTEST_IDENTITY_MARK', style: 'STYLE_MARK' } }).includes('SELFTEST_IDENTITY_MARK')
        && buildSystemPrompt({ persona: {}, action: 'idle' }).includes('主人已经有一阵子没跟你说话了')
        && buildSystemPrompt({ persona: {} }).includes('40 个字以内'),
        '空人格=用内置默认；四项人格与时机提示、40 字硬约束都进得了提示词');

      // (b) 设置窗口：新面板与字段真的铺开了吗（第 32 轮新增）
      try {
        const sw = openSettingsWindow('selftest-words');
        await new Promise((r) => sw.webContents.once('did-finish-load', r));
        await wait(1200);
        const form = await sw.webContents.executeJavaScript(`(() => {
          const ta = (k) => document.getElementById('persona-' + k);
          return {
            personaFields: ['identity', 'style', 'quirks', 'taboos', 'examples'].filter((k) => !!ta(k)),
            presets: document.querySelectorAll('#personaPresets button').length,
            placeholder: ta('identity') ? ta('identity').placeholder.length : 0,
            actionToggles: ['happy', 'happyOff', 'angry', 'idle'].filter((a) => !!document.querySelector('#actionToggles input[data-action="' + a + '"]')),
            idleUI: !!(document.getElementById('idleMinutes') && document.getElementById('idlePerDay')
              && document.getElementById('quietFrom') && document.getElementById('quietTo')
              && document.getElementById('idleEnabled') && document.getElementById('muted')),
            quietOptions: (document.getElementById('quietFrom') || { options: [] }).options.length,
            tryBtn: !!document.getElementById('tryLine'),
            promptBtn: !!document.getElementById('previewPrompt'),
            scrollH: Math.round(document.body.scrollHeight), viewH: Math.round(innerHeight),
          };
        })()`);
        fs.writeFileSync(path.join(ARTIFACTS, 'shot-settings.png'), (await sw.webContents.capturePage()).toPNG());
        push('设置窗口：人格与「她的话」面板真的长出来了',
          form.personaFields.length === 5 && form.presets >= 6 && form.placeholder > 10
          && form.actionToggles.length === 4 && form.idleUI === true && form.quietOptions === 24
          && form.tryBtn === true && form.promptBtn === true,
          `人格字段=${form.personaFields.join('/')} 预设=${form.presets} 个 占位符=${form.placeholder} 字`
          + ` 时机开关=${form.actionToggles.join('/')} 静音时段选项=${form.quietOptions} 个`
          + ` 试一句=${form.tryBtn} 看提示词=${form.promptBtn} 内容高=${form.scrollH}/视口=${form.viewH}`);
        // ※ 这里**不**断言"不用滚动"：加了两个面板之后内容本来就比视口高，滚动是预期行为。
        //   上一轮那条 fitsNoScroll 断言用的是紧凑排版，已经随本轮改动作废（见 devlog 的"改设计要改断言"）。
        sw.destroy();
        await wait(300);
      } catch (err) {
        push('设置窗口：人格与「她的话」面板真的长出来了', false, '打开失败: ' + (err && err.message));
      }

      // (c) 没配 API：四个动作**一律**念本地台词，一模一样（主人要求"不改变"）
      const offCfg = writeCfg({ apiKey: '', enabled: true, muted: false, mockReply: '' });
      const offLines = {};
      for (const a of ['happy', 'happyOff', 'angry', 'idle']) {
        const r = await requestActionLine(a, { force: true });
        offLines[a] = { source: r.source, text: r.text };
        push(`没配 API：${a} 念本地台词（不联网、零 token）`,
          r.source === 'local' && actionLines.LOCAL_LINES[a].includes(r.text),
          `来源=${r.source} 原因=${r.reason} 台词="${r.text}"`);
      }
      push('本地台词表已按主人指定的琴吹紬台词录入（第 33 轮）',
        actionLines.LOCAL_LINES.happy[0] === '今天有你在，什么都很甜呢'
        && actionLines.LOCAL_LINES.happyOff[1] === '那，先这样，我随时都在哦'
        && actionLines.LOCAL_LINES.happyOff[0] === '好啦，我把杯子收起来'   // ← 主人点名改的那句（原来写的是"尾巴"）
        && actionLines.LOCAL_LINES.pat.length === 3
        && offLines.pat === undefined,
        `happy 首句="${actionLines.LOCAL_LINES.happy[0]}"；收起来那句="${actionLines.LOCAL_LINES.happyOff[0]}"`
        + `（"尾巴"已去掉）；摸头=${actionLines.LOCAL_LINES.pat.length} 句（不进模型，四个时机的清单里没有它）`);

      // ★ 换人之后的"漏改探测器"：旧人设的词、鲸鱼娘的尾巴、各类点心，一个都不许再出现。
      //   为什么值得单独立一条：台词分散在**两个文件**（权威 lib/action-lines.js + 渲染层投影），
      //   换人时最容易漏改其中一处；靠人工核对迟早会漏，交给断言盯。
      const BANNED = ['人家', '本鲸', '白饭', '尾巴', '和菓子', '大福', '炒面', '点心'];      const allLocal = Object.entries(actionLines.LOCAL_LINES)
        .flatMap(([k, arr]) => arr.map((t) => ({ k, t })));
      const leaked = allLocal.filter(({ t }) => BANNED.some((w) => t.includes(w)));
      push('本地台词里没有旧人设的词、没有尾巴、没有任何点心（换人漏改探测器）',
        leaked.length === 0,
        leaked.length
          ? `漏了 ${leaked.length} 句：${leaked.map(({ k, t }) => `${k}:"${t}"`).join(' ')}`
          : `扫了 ${allLocal.length} 句，禁词表 ${BANNED.join('/')} 一个都没出现`);

      // ★ 渲染层那份 LINES 必须和权威表**逐字一致**：它是投影，不是第二份真值。
      //   这次换人正好踩到这个风险点（两边都得改），所以补一条断言永久盯着。
      const rendererLines = await js('window.__petTest.localLines()');
      const keys = Object.keys(actionLines.LOCAL_LINES);
      const mismatch = keys.filter((k) => {
        const a = (actionLines.LOCAL_LINES[k] || []).join('|');
        const b = ((rendererLines && rendererLines[k]) || []).join('|');
        return a !== b;
      });
      push('渲染层的台词投影与权威表逐字一致（两个文件不会各说各话）',
        mismatch.length === 0 && keys.length === Object.keys(rendererLines || {}).length,
        mismatch.length
          ? `不一致的组：${mismatch.join('/')}（改台词必须两边一起改）`
          : `六组台词（${keys.join('/')}）在 lib/action-lines.js 与 renderer.js 里逐字相同`);

      // (d) 「对话」关掉时也不许走模型
      writeCfg({ apiKey: 'sk-selftest-not-real', enabled: false, mockReply: '不许出现的一句' });
      const disabledLine = await requestActionLine('angry', { force: true });
      push('「启用对话」关掉时照样念本地台词（不偷偷联网）',
        disabledLine.source === 'local' && actionLines.LOCAL_LINES.angry.includes(disabledLine.text),
        `来源=${disabledLine.source} 原因=${disabledLine.reason}`);

      // (e) 接上 API：走模型，且**人格与时机提示都真的进了提示词**
      const apiCfg = writeCfg({ apiKey: 'sk-selftest-not-real', enabled: true, mockReply: '自检用的假回话' });
      const modelLine = await requestActionLine('happy', { force: true });
      push('接上 API：动作台词来自大模型（走完 chat() 整条链路，但不发真请求）',
        modelLine.source === 'model' && /自检用的假回话/.test(modelLine.text),
        `来源=${modelLine.source} 台词="${modelLine.text}"`);
      const promptIdle = buildSystemPrompt({ persona: apiCfg.persona, action: 'idle' });
      push('大模型收到的是**当前人格**：改人格 → 提示词跟着变（这是"可调"的判据）',
        promptIdle.includes('主人已经有一阵子没跟你说话了'),
        '空闲时机的提示词里带上了这个时机独有的指令（人格部分由 (a) 断言盯着）');

      // (f) 走模型失败 → **静默**退回本地台词，技术细节绝不进气泡
      writeCfg({ apiKey: 'sk-selftest-not-real', enabled: true, baseUrl: 'http://127.0.0.1:1', model: 'x', timeoutMs: 3000, mockReply: '' });
      const fallback = await requestActionLine('angry', { force: true });
      push('走模型失败 → 静默退回本地台词，气泡里不出现任何技术错误',
        fallback.source === 'local' && String(fallback.reason).startsWith('fallback_')
        && actionLines.LOCAL_LINES.angry.includes(fallback.text)
        && !/fetch|ENOTFOUND|HTTP|timeout/i.test(String(fallback.text)),
        `来源=${fallback.source} 原因=${fallback.reason} 台词="${fallback.text}"（技术细节只进 artifacts 日志）`);

      // (g) 逐个时机的开关：关掉哪个，哪个就回本地
      writeCfg({ apiKey: 'sk-selftest-not-real', enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', mockReply: '开着的时候来自模型', actionModel: { angry: false } });
      const angryOff = await requestActionLine('angry', { force: true });
      const happyOn = await requestActionLine('happy', { force: true });
      push('「她的话」的开关按时机生效（关掉 angry → 它回本地；happy 照旧走模型）',
        angryOff.source === 'local' && angryOff.reason === 'action_off'
        && happyOn.source === 'model',
        `angry: 来源=${angryOff.source} 原因=${angryOff.reason}；happy: 来源=${happyOn.source}`);

      // (h) 人格真的以文本进了请求的 system（用**独立的人格标记**验，不靠上一句的缓存）
      writeCfg({ apiKey: 'sk-selftest-not-real', enabled: true, mockReply: '人格标记测试', persona: { identity: 'PERSONA_MARK_18075', style: '毒舌一点', quirks: '爱喝红茶' } });
      const dbg = await apiLinesDebugPrompt('happy');
      push('人格文本进入实际请求的 system（改人格 = 改她的说话方式）',
        dbg.system.includes('PERSONA_MARK_18075') && dbg.system.includes('毒舌一点') && dbg.system.includes('爱喝红茶')
        && dbg.messages[0].role === 'system' && dbg.messages.length === 2,
        `system 里带 identity/style/quirks 三项；消息数=${dbg.messages.length}（无历史：动作反应是独立一句）`);

      // (h2) 默认人格已换成琴吹紬（第 33 轮）：预设第一项就是她，且带着她自己的东西
      // ⚠️ 禁止词只扫 identity/style/quirks/examples 四项：**taboos（禁忌）里必须能写
      //   "不用『人家』『本鲸』这类自称"** —— 那是正确的写法，第一版断言把 taboos 也一起禁了，
      //   结果把正确的写法判成错的（自检当场抓到）。
      const dflt = actionLines.PERSONA_PRESETS[0];
      const dfltPositive = [dflt.persona.identity, dflt.persona.style, dflt.persona.quirks, dflt.persona.examples].join('\n');
      const oldPersona = ['鲸鱼', '美人鱼', '白饭', '本鲸'].filter((w) => dfltPositive.includes(w));
      push('默认人格预设 = 琴吹紬（不再是鲸鱼娘）',
        dflt.label.includes('琴吹紬') && dfltPositive.includes('轻音少女') && dfltPositive.includes('键盘')
        && dfltPositive.includes('红茶') && dfltPositive.includes('古典乐')
        && dflt.persona.taboos.includes('人家')   // 禁忌栏**应该**点名列禁止的自称
        && oldPersona.length === 0,
        `预设名="${dflt.label}"；身份=轻音少女键盘手、爱好=红茶/古典乐、例句含茶；`
        + `旧人设词在身份/风格/癖好/例句里${oldPersona.length ? '仍有：' + oldPersona.join('/') : '一个都没有'}`
        + `（"禁忌"栏点名列了不许用的自称，这是对的，不参与禁词扫描）`);

      // (i) 空闲主动开口：走模型 → 台词进气泡
      const idleBase = new Date('2026-06-15T10:00:00').getTime();
      writeCfg({ apiKey: 'sk-selftest-not-real', enabled: true, mockReply: '空闲时会说的话', muted: false, actionModel: { idle: true }, idle: { enabled: true, minutes: 60, perDay: 12, quietFrom: 22, quietTo: 8 } });
      // ★ 注入的"现在"必须**远超过** minutes × 抖动的上限：闸门里有 ±25% 随机抖动，
      //   写 70 分钟而阈值是 60×1.25=75 分钟时会**随随机数偶发变红**（实测踩过：同一条断言一次绿一次红）。
      //   所以"上次开口/上次理她"都放到 3 小时前 —— 任何抖动下都稳稳超过阈值。
      const idleNowMs = idleBase + 70 * 60 * 1000;
      const idleOldBase = idleBase - 3 * 60 * 60 * 1000;
      // 三样都要注入才轮得到"她该开口了"：现在几点 / 上次开口 / 上次主人理她。
      await idleStateInject({ test: true, enabled: true, nowMs: idleNowMs, baseMs: idleOldBase, baselineMs: idleOldBase });
      const idleTick = await idleTickOnce(true);
      await wait(400);
      const idleState = await js('window.__petTest.state()');
      push('空闲满设定时长 → 她主动开口（台词来自大模型，落到气泡里）',
        idleTick.ok === true && idleTick.reason === 'spoken' && /空闲时会说的话/.test(String(idleTick.text))
        && /空闲时会说的话/.test(String(idleState.lastSay)),
        `tick=${idleTick.reason} 台词="${idleTick.text}"（气泡里="${idleState.lastSay}"）`);

      // (j) 每日上限：接着**同一段注入时间**、把上限压到 1 —— 这时今天已经说过 1 次了。
      //    ⚠️ 必须复用同一个 nowMs：计数是按"本地日期"归零的，换一天就等于归零，
      //       那样"到上限了没"这条会因为刚归零而永远轮不到（实测踩过）。
      //    ⚠️ baseMs/baselineMs 也用那个"3 小时前"：否则 too_soon（含 ±25% 抖动）会先拦下来。
      writeCfg({ idle: { enabled: true, minutes: 60, perDay: 1, quietFrom: 22, quietTo: 8 } });
      const capInject = await idleStateInject({ test: true, nowMs: idleNowMs, baseMs: idleOldBase, baselineMs: idleOldBase });
      const capped = await idleTickOnce(true);
      push('每天最多开口 N 次：到上限就闭嘴（不烧 token）',
        capInject.gate.allow === false && capInject.gate.reason === 'daily_cap'
        && capped.ok === false && capped.reason === 'daily_cap',
        `今日已开口 ${capInject.spokenToday}/上限 ${apiConfig.load().idle.perDay} → 判定=${capInject.gate.reason}（不是"她坏了"，是限额到了）`);

      // (k) 静音时段（跨午夜）
      const quietInject = await idleStateInject({ test: true, nowMs: new Date('2026-06-16T02:00:00').getTime(), baseMs: new Date('2026-06-15T18:00:00').getTime() });
      push('静音时段（22 点→8 点）里绝不主动开口，跨午夜也算对',
        quietInject.gate.allow === false && quietInject.gate.reason === 'quiet_hours'
        && actionLines.inQuietHours(2, 22, 8) === true && actionLines.inQuietHours(12, 22, 8) === false
        && actionLines.inQuietHours(22, 22, 8) === true && actionLines.inQuietHours(8, 22, 8) === false,
        `凌晨 2 点 → ${quietInject.gate.reason}；边界：22 点算静音、8 点算结束、中午不算`);

      // (l) 一键静音（右键菜单那一项 / 设置页那个勾）
      writeCfg({ muted: true });
      const mutedInject = await idleStateInject({ test: true, nowMs: new Date('2026-06-16T14:00:00').getTime(), baseMs: new Date('2026-06-16T10:00:00').getTime() });
      push('一键静音：她不再主动开口（主人自己找她聊不受影响）',
        mutedInject.muted === true && mutedInject.gate.allow === false && mutedInject.gate.reason === 'user_muted',
        `muted=${mutedInject.muted} 判定=${mutedInject.gate.reason}`);
      writeCfg({ muted: false });

      // (m) 主人一理她 → 空闲计时归零（刚聊完不许马上"主动搭话"）
      // ★ 关掉注入的"现在"：这条断言量的就是**真实的墙钟时间**（用假时间会算出天文数字的时间差）。
      //   但**仍要注入 baselineMs**：markUserActive() 内部走的也是 idleNow()，
      //   两边必须取同一个时间原点，否则"差了几毫秒"会变成几百万毫秒（实测踩过）。
      await idleStateInject({ test: true, enabled: false });
      const t0 = Date.now();   // 现在 / 上次开口 / 上次主人理她 —— 三样用同一个原点
      await idleStateInject({ test: true, enabled: true, nowMs: t0, baseMs: t0, baselineMs: t0 });
      markUserActive('selftest');
      const afterTouch = await idleStateInject({ test: true });
      push('主人一理她，空闲计时归零（刚互动完不会马上自己冒出来说话）',
        Math.abs(afterTouch.lastUserAt - t0) < 5000
        && afterTouch.gate.allow === false && afterTouch.gate.reason === 'too_soon',
        `lastUserAt 刚更新（差 ${afterTouch.lastUserAt - t0}ms）→ 判定=${afterTouch.gate.reason}`
        + `（等 ${Math.round((afterTouch.gate.waitMs || 0) / 1000)} 秒后才轮到"可以开口"）`);

      // (n) 配置文件手改坏也不能崩：脏字段一律丢掉、范围值夹回去
      const dirty = writeCfg({ actionModel: { angry: true, 不存在的时机: true }, idle: { minutes: 9999, perDay: -5, quietFrom: 99, quietTo: 'x' }, persona: { identity: '只填这一项', 乱七八糟: '丢掉' } });
      push('配置被手改坏也安全：脏字段丢掉、越界值夹回范围、未知时机开关忽略',
        dirty.actionModel['不存在的时机'] === undefined
        && dirty.idle.minutes === actionLines.IDLE_LIMITS.minutesMax
        && dirty.idle.perDay === 0 && dirty.idle.quietFrom === 23
        && dirty.persona.identity === '只填这一项' && dirty.persona['乱七八糟'] === undefined,
        `minutes 9999→${dirty.idle.minutes}（上限） perDay -5→${dirty.idle.perDay} quietFrom 99→${dirty.idle.quietFrom}`
        + ` 未知时机=${dirty.actionModel['不存在的时机']} 未知人格字段=${dirty.persona['乱七八糟']}`);

      // (o) 安全性：渲染层拿不到密钥，也拿不到"能不能直接调模型"的口子
      // ⚠️ 必须**先放一个（假的）密钥**再量：否则掩码本来就是空的，这条断言会变成恒真（假绿）。
      writeCfg({ apiKey: 'sk-selftest-not-real' });
      const secView = JSON.stringify(apiConfig.publicView());
      push('新面板没有开新的泄密口子（密钥仍然不进渲染层）',
        !secView.includes('sk-selftest-not-real') && apiConfig.publicView().maskedKey.includes('•'),
        `安全视图里没有明文密钥（掩码=${apiConfig.publicView().maskedKey}，长度=${secView.length} 字节的视图里找不到 sk- 原文）`);
    } finally {
      // 把配置还原成主人本来的那份（自检是客人，不许把主人的设置改坏）
      restoreCfg();
      await idleStateInject({ test: true, enabled: false });
      await js('window.__petTest.sayLine("")');   // 清掉自检留下的台词，后面的截图才干净
      await wait(200);
    }
  }

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

// ---------- API 设置 + 对话（第 25 轮） ----------
//
// 三层分工，别搞混：
//   1) 密钥与配置：lib/api-config.js（主进程；渲染层永远拿不到真实密钥）
//   2) 网络请求：lib/chat.js（主进程；渲染层有 CSP，本来也发不出去）
//   3) 界面：设置窗口（settings.html）+ 桌宠气泡上那一行输入框（renderer.js）
//
// 对话历史也放主进程：渲染层只负责"把主人说的话发过来、把回复显示出来"，
// 免得刷新页面/重开面板就把上下文弄丢。

const chatState = {
  history: [],        // [{role:'user'|'assistant', content}]，只留最近 N 轮
  last: null,         // 最近一次结果（自检与诊断用）
  sending: false,
  contextLost: false, // 送上下文时被接口拒了，就退回单轮重试一次（见 sendChat）
};

// 设置窗口：**独立小窗**，不是塞进桌宠那个 200x250 的透明窗口。
// 理由写在 devlog/round-25.md：桌宠窗口是逐像素穿透的透明窗，
// 在里面塞表单既要改穿透掩码、又会被窗口尺寸绑死，得不偿失。
let settingsWin = null;
function openSettingsWindow(from) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    logInput({ src: 'main', type: 'settings', detail: `设置窗口已存在，叫到前面（来源=${from}）` });
    return settingsWin;
  }
  settingsWin = new BrowserWindow({
    // 高度 760（150% DPI 下视口约 700 逻辑像素）：实测紧凑排版后设置页内容约 686px，
    // 760 能一次把「保存 / 测试连接 / 状态 / 配置路径」全看全，不用先滚动找按钮。
    width: 470,
    height: 760,
    minWidth: 400,
    minHeight: 420,
    resizable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    title: '桌宠 · 设置（接入 API）',
    backgroundColor: '#eef4f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);   // 设置窗口不需要"文件/编辑/视图"那一排
  settingsWin.loadFile(path.join(ROOT, 'renderer', 'settings.html'));
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => { settingsWin = null; });
  logInput({ src: 'main', type: 'settings', detail: `打开设置窗口（来源=${from}）` });
  return settingsWin;
}

// 发一句话给她，把回复塞进气泡。**永远不 throw**：任何失败都要有一句台词。
async function sendChat(text, source) {
  const cfg = apiConfig.load();
  const msg = String(text || '').trim().slice(0, 200);
  if (!msg) return { ok: false, kind: 'empty', text: '' };
  markUserActive('sendChat');   // 主人在跟她说话 → 空闲计时归零（别刚聊完她就"主动搭话"）
  if (chatState.sending) {
    return { ok: false, kind: 'busy', text: '（人家还在想上一句呢…）' };
  }
  chatState.sending = true;
  const started = Date.now();
  try {
    // 组装 messages：人设 + 最近 N 轮 + 这一句
    const messages = [{ role: 'system', content: apiConfig.systemPrompt(cfg) }];
    if (cfg.historyRounds > 0) {
      messages.push(...chatState.history.slice(-cfg.historyRounds * 2));
    }
    messages.push({ role: 'user', content: msg });

    let res = await chatApi.chat(cfg, messages);
    // 有的网关不接受 system 角色或多轮上下文（报 400）→ 退回单轮再试一次，
    // 而不是直接让主人看到"对面回的话人家看不懂"。这就是"能降级就别报错"。
    if (!res.ok && res.status === 400 && messages.length > 2) {
      logInput({ src: 'main', type: 'chat', detail: '带上下文被拒（HTTP 400）→ 退回单轮重试' });
      chatState.contextLost = true;
      res = await chatApi.chat(cfg, [{ role: 'user', content: msg }]);
    }

    chatState.last = { ...res, at: new Date().toISOString(), source, ms: res.ms || (Date.now() - started) };
    if (res.ok) {
      chatState.history.push({ role: 'user', content: msg });
      chatState.history.push({ role: 'assistant', content: res.text });
      const keep = Math.max(2, (cfg.historyRounds || 0) * 2);
      if (chatState.history.length > keep) chatState.history = chatState.history.slice(-keep);
      logInput({ src: 'main', type: 'chat', detail: `对话成功（${res.ms}ms，${res.text.length} 字）` });
    } else {
      // 失败不写进历史：免得下一次请求带着一串"没答上的问题"污染上下文
      logInput({ src: 'main', type: 'chat', detail: `对话失败 kind=${res.kind} ${res.detail || res.text}` });
    }
    if (win && !win.isDestroyed()) {
      // 成功时给长一点；失败那句也别一闪而过（主人得看清"是钥匙不对还是没网"）
      win.webContents.send('pet:say', res.text, res.ok ? 5200 : 4200);
      if (res.ok) win.webContents.send('pet:action', 'happy');
    }
    return res;
  } finally {
    chatState.sending = false;
  }
}

ipcMain.handle('pet:api-config-get', () => {
  const view = apiConfig.publicView();
  logInput({ src: 'main', type: 'api-config', detail: `读取设置（hasKey=${view.hasKey} 地址=${view.baseUrl} 模型=${view.model}）` });
  return view;
});
ipcMain.handle('pet:api-config-save', (_e, patch) => {
  const merged = apiConfig.save(patch || {});
  const view = apiConfig.publicView(merged);
  // ★ 日志里**绝不能出现密钥**：只记"配了没有 / 换成什么地址"
  logInput({ src: 'main', type: 'api-config', detail: `保存设置（hasKey=${view.hasKey} 地址=${view.baseUrl} 模型=${view.model} 记忆=${view.historyRounds} 轮）` });
  return view;
});
ipcMain.handle('pet:api-presets', () => apiConfig.PRESETS);
ipcMain.handle('pet:api-test', async () => {
  const res = await chatApi.testConnection(apiConfig.load());
  logInput({ src: 'main', type: 'api-test',
    detail: res.ok ? `测试连接成功（${res.ms}ms）：${res.text}` : `测试连接失败 kind=${res.kind} ${res.detail || res.text}` });
  chatState.last = { ...res, at: new Date().toISOString(), source: 'test' };
  return res;
});
ipcMain.handle('pet:chat-send', async (_e, payload) => {
  const text = payload && payload.text;
  const from = (payload && payload.source) || 'ui';
  const res = await sendChat(text, from);
  // 渲染层要的是"立刻能显示的东西"：真正的台词（成功或失败都有），外加 ok 供自检判定
  return { ok: !!res.ok, kind: res.kind, text: res.text, ms: res.ms || 0, sending: false };
});
ipcMain.handle('pet:chat-state', () => ({
  sending: chatState.sending,
  history: chatState.history.length,
  last: chatState.last,
  contextLost: chatState.contextLost,
  ready: apiConfig.publicView().ready,
}));
// 设置窗口的"打开配置文件位置"：直接把 api-config.json 在资源管理器里选中，
// 主人想手动备份/搬到别的电脑时用得上（也能顺手确认"密钥到底存在哪")
ipcMain.handle('pet:open-config-file', () => {
  const p = apiConfig.getConfigPath();
  try {
    const { shell } = require('electron');
    if (fs.existsSync(p)) shell.showItemInFolder(p);
    else shell.openPath(path.dirname(p));
    return { ok: true, path: p };
  } catch (err) {
    return { ok: false, path: p, error: String(err && err.message || err) };
  }
});
// 长回复要能待在屏幕上：气泡显示时长由渲染层按字数决定（见 renderer.js 的 say）
ipcMain.on('pet:open-settings', (_e, payload) => openSettingsWindow((payload && payload.source) || 'ipc'));

// =====================================================================================
// 第 32 轮：她的话 —— 动作类台词可走模型 + 空闲主动开口（带限频与静音）
//
// 【为什么判定逻辑不在渲染层】
//   渲染层只该管"把这句话显示出来"。走模型还是念本地、要不要限频、静音时段算不算，
//   全部集中在主进程：那里才有配置、网络和日志。渲染层调一次 `pet:action-line` 拿结果。
//
// 【两条不能破的底线】
//   1) 离线零变化：没配 API / 关掉对话 / 模型失败 / 返回空 → 一律退回本地台词（lib/action-lines.js），
//      一个字都不许变（主人 2026-10-02 的要求）。
//   2) 失败不进气泡：动作类失败**静默**退回本地台词，技术细节只进 artifacts 日志。
//      （聊天那条路失败要开口，因为那是主人在问；动作这条路是她在反应，不该蹦英文报错。）
// =====================================================================================

const lineState = {
  lastUserAt: 0,     // 最近一次"主人理了她"（点击/拖动/发消息）
  lastSpokeAt: 0,    // 最近一次空闲开口
  spoken: 0,         // 今天开口次数（按本地日期归零，见 spokenToday）
  spokenKey: '',     // 上面那个计数属于哪一天
  idleBusy: false,   // 正在为"空闲开口"发请求
};
let idleTimer = null;
let idleNotifyInFlight = false;   // 每 30 秒一次心跳，防重入

// 自检用：把"现在几点、主人安静了多久"做成可注入的（否则断言要么等到半夜、要么干等 15 分钟）
//   nowMs      = 假的"现在"
//   baseMs     = 假的"上次开口时间"
//   baselineMs = 假的"上次主人理她时间" —— 缺了它，too_soon 这条闸门会在别的断言前面先拦下来
//                （第 32 轮实测：不注入 baselineMs 时，daily_cap / quiet_hours 永远轮不到，全被 too_soon 挡）
const idleTest = { enabled: false, nowMs: 0, baseMs: 0, baselineMs: 0 };
const idleNow = () => (idleTest.enabled && idleTest.nowMs ? idleTest.nowMs : Date.now());

function todayKey(now) {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function spokenToday(now) {
  const k = todayKey(now);
  if (lineState.spokenKey !== k) { lineState.spokenKey = k; lineState.spoken = 0; }
  return lineState.spoken;
}

function markUserActive(reason) {
  lineState.lastUserAt = idleNow();
  if (reason) logInput({ src: 'main', type: 'idle-touch', detail: `主人理她了（${reason}）→ 空闲计时归零` });
}

function idleGateNow() {
  const cfg = apiConfig.load();
  const now = idleNow();
  const base = idleTest.enabled && idleTest.baseMs ? idleTest.baseMs : lineState.lastSpokeAt;
  const needsBaseline = !!(idleTest.enabled && idleTest.baselineMs);
  const decision = actionLines.idleGate({
    idle: cfg.idle,
    muted: cfg.muted,
    ready: !!(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model),
    spokenToday: spokenToday(now),
    lastSpokeAt: base,
    lastUserAt: needsBaseline ? idleTest.baselineMs : lineState.lastUserAt,
  }, now);
  return {
    ...decision, now, at: new Date(now).toISOString(), idle: cfg.idle, muted: !!cfg.muted,
    baselineUsed: needsBaseline ? idleTest.baselineMs : lineState.lastUserAt,
  };
}

// 空闲开口的实际动作：走模型 → 塞进气泡。**失败静默**（不打断主人），只在日志里留痕。
async function idleSpeakOnce() {
  const cfg = apiConfig.load();
  const started = Date.now();
  lineState.spoken = spokenToday(idleNow()) + 1;
  lineState.lastSpokeAt = idleNow();
  try {
    const messages = actionLines.buildActionMessages({
      persona: cfg.persona, legacyPrompt: cfg.systemPrompt, action: 'idle',
      userText: '（主人有一阵子没说话了）',
    });
    if (cfg.historyRounds > 0) {
      // 空闲搭话**带上下文**：她能接着刚才聊的事说，而不是每次从零开始（这也是"活"的关键）
      messages.splice(1, 0, ...chatState.history.slice(-cfg.historyRounds * 2));
    }
    const res = await chatApi.chat(cfg, messages);
    if (res.ok && res.text) {
      chatState.history.push({ role: 'assistant', content: res.text });
      const keep = Math.max(2, (cfg.historyRounds || 0) * 2);
      if (chatState.history.length > keep) chatState.history = chatState.history.slice(-keep);
      if (win && !win.isDestroyed()) win.webContents.send('pet:say', res.text, 5200);
      logInput({ src: 'main', type: 'idle-speak', detail: `空闲主动开口成功（${res.ms}ms，今日第 ${lineState.spoken} 次）：${res.text}` });
      return { ok: true, text: res.text, ms: res.ms };
    }
    logInput({ src: 'main', type: 'idle-speak', detail: `空闲主动开口失败 kind=${res.kind} ${res.detail || res.text}（不打扰主人，静默跳过）` });
    return { ok: false, kind: res.kind, text: res.text, ms: Date.now() - started };
  } catch (err) {
    logInput({ src: 'main', type: 'idle-speak', detail: `空闲主动开口异常：${err && err.message}` });
    return { ok: false, kind: 'error', text: String(err && err.message || err) };
  }
}

// 心跳：每 30 秒问一次"该不该开口"。**只问一次判定，不在判定里发请求**（见 devlog 里那条"闸门顺序"的教训）。
async function idleTickOnce(force) {
  if (idleNotifyInFlight) return { ok: false, reason: 'busy' };
  idleNotifyInFlight = true;
  try {
    if (lineState.idleBusy) return { ok: false, reason: 'speaking' };
    const decision = idleGateNow();
    if (!decision.allow) return { ok: false, reason: decision.reason, decision };
    logInput({ src: 'main', type: 'idle-tick', detail: `空闲满 ${decision.idle.minutes} 分钟 → 她主动开口（今日第 ${spokenToday(idleNow()) + 1} 次）` });
    lineState.idleBusy = true;
    try {
      const res = await idleSpeakOnce();
      return { ok: !!res.ok, reason: 'spoken', text: res.text, ms: res.ms, decision };
    } finally {
      lineState.idleBusy = false;
    }
  } finally {
    idleNotifyInFlight = false;
    if (force) idleTest.didForce = true;
  }
}

function startIdleTicker() {
  if (idleTimer) return;
  // 30 秒粒度足够：最短间隔是 1 分钟，肉眼感知不到这半分钟的误差，而 CPU 几乎为零
  idleTimer = setInterval(() => { idleTickOnce().catch(() => { /* 心跳不许把进程带崩 */ }); }, 30000);
  if (idleTimer.unref) idleTimer.unref();   // 别让心跳拦着进程退出
}

function toggleMute(next, from) {
  const cur = apiConfig.load().muted;
  const val = next === undefined ? !cur : !!next;
  apiConfig.save({ muted: val });
  logInput({ src: 'main', type: 'mute', detail: `${val ? '静音' : '恢复'}（来源=${from}）` });
  if (win && !win.isDestroyed()) win.webContents.send('pet:mute-changed', val);
  return val;
}

// 动作类台词：走模型还是念本地？——**这是一个函数说了算**，渲染层不重复判一遍。
async function requestActionLine(action, opts) {
  const o = opts || {};
  const allowed = actionLines.ACTIONS.indexOf(action) >= 0;
  if (!allowed) return { ok: true, source: 'local', action, text: actionLines.pickLocal('click'), reason: 'unknown_action' };
  const cfg = apiConfig.load();
  const wantModel = cfg.actionModel[action] !== false;
  const ready = !!(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model);
  const base = {
    text: actionLines.pickLocal(action),
    // 本地兜底也把"为什么没走模型"说清楚：设置页要显示，自检要断言
    reason: !wantModel ? 'action_off' : (!cfg.enabled ? 'api_disabled' : (!cfg.apiKey ? 'no_key' : ((!cfg.baseUrl || !cfg.model) ? 'no_model' : 'unknown'))),
  };
  if (AUTOTEST && !o.force) return { ok: true, source: 'local', action, force: false, ...base };  if (!ready || !wantModel) {
    return { ok: true, source: 'local', action, ...base };
  }
  // 走模型：**无历史**（动作反应是独立的一句，不把内部提示写进对话历史）
  try {
    const messages = actionLines.buildActionMessages({
      persona: cfg.persona, legacyPrompt: cfg.systemPrompt, action, userText: o.userText,
    });
    const res = await chatApi.chat(cfg, messages);
    if (res.ok && res.text) {
      logInput({ src: 'main', type: 'action-line', detail: `动作「${action}」走模型成功（${res.ms}ms，${res.text.length} 字）：${res.text}` });
      return { ok: true, source: 'model', action, text: res.text, raw: res.raw, ms: res.ms, reason: 'ok' };
    }
    // 失败不进气泡：动作类走模型的失败**静默**退回本地台词（见函数头注释）
    logInput({ src: 'main', type: 'action-line', detail: `动作「${action}」走模型失败 kind=${res.kind} ${res.detail || res.text} → 静默退回本地台词` });
    return { ok: true, source: 'local', action, ...base, reason: `fallback_${res.kind || 'error'}`, ms: res.ms, lastError: res.detail || res.text };
  } catch (err) {
    logInput({ src: 'main', type: 'action-line', detail: `动作「${action}」走模型异常：${err && err.message} → 静默退回本地台词` });
    return { ok: true, source: 'local', action, ...base, reason: 'fallback_error' };
  }
}

// 自检用的 idle 状态注入与观测：**处理器与断言共用这一份**，避免"测的是副本"。
// （pet:idle-state 的 IPC 处理器就是转调它；AUTOTEST 之外一律拒绝注入。）
function idleStateForTest(payload) {
  const p = payload || {};
  if (p.test && !AUTOTEST) return { ok: false, reason: 'not_autotest' };
  if (p.test) {
    if (p.nowMs) idleTest.nowMs = Number(p.nowMs);
    if (p.baseMs !== undefined) idleTest.baseMs = Number(p.baseMs);
    if (p.baselineMs !== undefined) idleTest.baselineMs = Number(p.baselineMs);
    if (p.enabled !== undefined) idleTest.enabled = !!p.enabled;
  }
  return {
    ok: true, gate: idleGateNow(), idleTest: { ...idleTest },
    spokenToday: spokenToday(idleNow()), lastUserAt: lineState.lastUserAt, lastSpokeAt: lineState.lastSpokeAt,
    muted: !!apiConfig.load().muted,
  };
}

ipcMain.handle('pet:action-line', async (_e, payload) => {
  const action = String((payload && payload.action) || '');
  return requestActionLine(action, { userText: payload && payload.userText, force: !!(payload && payload.force) });
});
// 设置窗口的「看看现在的提示词」：把**最终拼出来的 system 提示词**原样给回去。
// 只给提示词文本，不含密钥（密钥压根不在提示词里，这条边界见 lib/api-config.js 的注释）。
ipcMain.handle('pet:debug-prompt', (_e, payload) => {
  const action = String((payload && payload.action) || 'idle');
  const cfg = apiConfig.load();
  return {
    action,
    system: actionLines.buildSystemPrompt({ persona: cfg.persona, legacyPrompt: cfg.systemPrompt, action }),
    messages: actionLines.buildActionMessages({ persona: cfg.persona, legacyPrompt: cfg.systemPrompt, action }),
    ready: !!(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model),
  };
});
ipcMain.handle('pet:action-line-lines', () => actionLines.LOCAL_LINES);
ipcMain.on('pet:user-active', (_e, payload) => markUserActive((payload && payload.reason) || 'ui'));
ipcMain.on('pet:toggle-mute', (_e, payload) => toggleMute(payload && payload.mute, (payload && payload.source) || 'ipc'));
ipcMain.handle('pet:mute-get', () => ({ muted: !!apiConfig.load().muted }));
// 自检专用：把 idle 的时间与状态做成可注入的（**只在 AUTOTEST 下可用**，正式运行一律拒绝）
ipcMain.handle('pet:idle-state', (_e, payload) => idleStateForTest(payload));
ipcMain.handle('pet:idle-tick', async (_e, payload) => {
  const p = payload || {};
  if (p.test && !AUTOTEST) return { ok: false, reason: 'not_autotest' };
  if (p.test) {
    if (p.nowMs) idleTest.nowMs = Number(p.nowMs);
    if (p.baseMs !== undefined) idleTest.baseMs = Number(p.baseMs);
    // 自检注入的时间只在本次 tick 有效，跑完就关，免得污染后面的断言
    idleTest.enabled = true;
  }
  const res = await idleTickOnce(true);
  if (p.test) idleTest.enabled = false;
  return res;
});

app.whenReady().then(() => {
  // 配置路径依赖 userData，所以要在 whenReady 之后（也是 app.getPath 可用的最早时机）。
  // userData 就是 %APPDATA%\dsh-desktop-pet —— 便携版和安装版共用同一份设置。
  apiConfig.init(app.getPath('userData'));
  lineState.lastUserAt = Date.now();   // 刚启动 = 主人刚理过她，不该一上来就主动开口
  createWindow();
  startIdleTicker();                   // 空闲开口心跳（每 30 秒判一次，判据在 idleGateNow）
});

app.on('window-all-closed', () => {
  if (!AUTOTEST) app.quit();
});
