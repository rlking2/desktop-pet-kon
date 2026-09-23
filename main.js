// 鲸鱼娘桌宠 · 主进程
// 阶段0 目标：透明 / 无边框 / 永远置顶 / 能拖 / 右键菜单 / AUTOTEST 自检
const { app, BrowserWindow, Menu, ipcMain, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = __dirname;
const ARTIFACTS = path.join(ROOT, 'artifacts');
const AUTOTEST = process.env.DSH_PET_AUTOTEST === '1';
const WIN_W = 260;
const WIN_H = 320;

let win = null;
const diag = { warnings: [], errors: [], console: [] };

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

  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: work.x + work.width - WIN_W - 40,
    y: work.y + work.height - WIN_H - 40,
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

  win.once('ready-to-show', () => {
    win.show();
    // 注意：自检时不打开红色边框层——辅助线会污染被检截图。
    // 需要看窗口边界时用 DSH_PET_DEBUG=1 单独启动。
    if (process.env.DSH_PET_DEBUG === '1') win.webContents.send('pet:debug-overlay', true);
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

// ---------- 右键菜单 ----------
function openMenu() {
  const menu = Menu.buildFromTemplate([
    { label: '🐋 鲸鱼娘桌宠 · 阶段0', enabled: false },
    { type: 'separator' },
    { label: '永远置顶', type: 'checkbox', checked: win.isAlwaysOnTop(), click: (mi) => win.setAlwaysOnTop(mi.checked, 'floating') },
    { label: '让她说句话', click: () => win.webContents.send('pet:say', '主人……人家在的啦，哼。') },
    { label: '摸头', click: () => win.webContents.send('pet:action', 'headpat') },
    { label: '喂白饭（+1 token）', click: () => win.webContents.send('pet:action', 'rice') },
    { type: 'separator' },
    { label: '回到底部右侧', click: () => {
        const work = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x: work.x + work.width - WIN_W - 40, y: work.y + work.height - WIN_H - 40, width: WIN_W, height: WIN_H });
      } },
    { label: '开发者工具', click: () => win.webContents.openDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: '退出（人家要下班了）', click: () => app.quit() },
  ]);
  menu.popup({ window: win });
}

ipcMain.on('pet:context-menu', () => openMenu());
ipcMain.on('pet:quit', () => app.quit());

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
        // 拖动能力：Electron 靠 -webkit-app-region: drag 实现，可断言
        dragRegion: getComputedStyle(q('#pet')).webkitAppRegion,
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
    const TOL = 4;
    const dw = Math.abs(metrics.innerSize.w - WIN_W);
    const dh = Math.abs(metrics.innerSize.h - WIN_H);
    push('窗口尺寸符合设计(±4)', dw <= TOL && dh <= TOL,
      `视口 ${metrics.innerSize.w}x${metrics.innerSize.h} / 设计 ${WIN_W}x${WIN_H}（偏差 ${dw}x${dh}，DPR ${state.devicePixelRatio}）`);
    push('完整落在工作区内', state.insideWorkArea === true, `bounds=${JSON.stringify(b)} workArea=${JSON.stringify(display.workArea)}`);
    push('透明背景（body 非纯色）', /rgba\(0, 0, 0, 0\)|transparent/.test(metrics.bodyBg), `bodyBg=${metrics.bodyBg}`);
    push('占位形象已渲染', metrics.petVisible === true && !!metrics.petRect, `petRect=${JSON.stringify(metrics.petRect)}`);
    push('尾鳍元素存在', !!metrics.tailRect, `tailRect=${JSON.stringify(metrics.tailRect)}`);
    push('待机动画在跑', !!metrics.animRunning && metrics.animRunning !== 'none', `animationName=${metrics.animRunning}`);
    push('角色可拖动（drag 区域已生效）', metrics.dragRegion === 'drag', `-webkit-app-region=${metrics.dragRegion}`);
    push('截图非空白', opaqueRatio > 0.02, `opaqueRatio=${opaqueRatio}`);
    push('无渲染错误', diag.errors.length === 0, `errors=${diag.errors.length}`);

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
    for (const c of inter.checks) report.checks.push(c);
    console.log('--- 交互断言 ---');
    for (const c of inter.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
    console.log(`交互截图: ${inter.screenshot}`);

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

  // 交互中窗口应保持稳定
  const b2 = win.getBounds();
  push('交互后窗口未跑位', Math.abs(b2.width - WIN_W) <= 4 && Math.abs(b2.height - WIN_H) <= 4 && win.isVisible(),
    `bounds=${b2.width}x${b2.height} visible=${win.isVisible()}`);

  const shot = path.join(ARTIFACTS, 'shot-interaction.png');
  fs.writeFileSync(shot, (await win.webContents.capturePage()).toPNG());

  return {
    screenshot: path.relative(ROOT, shot),
    finalState: s,
    checks,
  };
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (!AUTOTEST) app.quit();
});
