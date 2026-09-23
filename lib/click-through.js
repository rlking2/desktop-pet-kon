// 鼠标穿透：用窗口自身的 alpha 掩码做逐像素命中检测
//
// 原理：
//   1. 窗口启动时用 capturePage() 截一张自身图像，把 alpha 通道降采样成"实体像素地图"(mask)
//      —— 角色本体、名牌、气泡、阴影都算实体；透明留白算空气
//   2. 主进程定时读鼠标屏幕坐标，换算成窗口内坐标 → 查掩码
//   3. 命中实体 → setIgnoreMouseEvents(false)，可点可拖
//      命中空气 → setIgnoreMouseEvents(true, { forward: true })，点击穿透给桌面
//      forward:true 是关键：穿透状态下仍然收得到 mousemove，才能判断什么时候该收回控制权
//
// 为什么不用 CSS -webkit-app-region: drag？
//   它只认矩形区域，跟逐像素穿透天然冲突（留白也会被当成可拖动），所以拖动改成手动实现。

const ALPHA_THRESHOLD = 90; // 0-255，低于此值视为空气（屏蔽抗锯齿边缘的虚边）
const DOWNSCALE = 4;        // 降采样倍数，省内存且对边缘更宽容
const POLL_MS = 60;         // 鼠标轮询间隔

function buildMaskFromNativeImage(image, winW, winH, dpr) {
  const size = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const mw = Math.max(1, Math.ceil(size.width / DOWNSCALE));
  const mh = Math.max(1, Math.ceil(size.height / DOWNSCALE));
  const data = Buffer.alloc(mw * mh);
  let opaque = 0;
  let minX = mw, minY = mh, maxX = -1, maxY = -1;

  for (let y = 0; y < size.height; y++) {
    const my = Math.floor(y / DOWNSCALE);
    for (let x = 0; x < size.width; x++) {
      const a = bitmap[(y * size.width + x) * 4 + 3];
      if (a < ALPHA_THRESHOLD) continue;
      const i = my * mw + Math.floor(x / DOWNSCALE);
      if (data[i] === 0) {
        data[i] = 1;
        opaque++;
        const mx = Math.floor(x / DOWNSCALE);
        if (mx < minX) minX = mx;
        if (mx > maxX) maxX = mx;
        if (my < minY) minY = my;
        if (my > maxY) maxY = my;
      }
    }
  }

  return {
    data, mw, mh,
    scaleX: size.width / winW,
    scaleY: size.height / winH,
    dpr,
    physical: `${size.width}x${size.height}`,
    opaque,
    bbox: maxX < 0 ? null : { minX, minY, maxX, maxY },
    coverage: +(opaque / (mw * mh)).toFixed(4),
  };
}

function installClickThrough(win, { buildMask } = {}) {
  let mask = null;
  let ignoring = null;      // null = 还没设过
  let dragging = false;
  let lastCursor = { x: -1, y: -1 };
  let lastWinPos = { x: -1, y: -1 };
  let lastHit = null;
  const stats = { hits: 0, misses: 0, toggles: 0, probes: 0, lastProbe: null };

  // 默认先进入穿透态，避免启动瞬间挡住桌面点击
  win.setIgnoreMouseEvents(true, { forward: true });
  ignoring = true;

  function windowOrigin() {
    const b = win.getBounds(); // 逻辑像素（DIP），与 screen 坐标同一套
    return { x: b.x, y: b.y };
  }

  function hitTest(offsetX, offsetY) {
    if (!mask) return null;
    const mx = Math.floor((offsetX * mask.scaleX) / DOWNSCALE);
    const my = Math.floor((offsetY * mask.scaleY) / DOWNSCALE);
    if (mx < 0 || my < 0 || mx >= mask.mw || my >= mask.mh) return false;
    return mask.data[my * mask.mw + mx] === 1;
  }

  function apply(shouldIgnore) {
    if (ignoring === shouldIgnore) return;
    ignoring = shouldIgnore;
    stats.toggles++;
    if (shouldIgnore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  }

  function probe() {
    if (!win || win.isDestroyed()) return;
    const pt = require('electron').screen.getCursorScreenPoint();
    const origin = windowOrigin();
    const b = win.getBounds();

    // 鼠标和窗口都没动就不重复算
    if (pt.x === lastCursor.x && pt.y === lastCursor.y &&
        origin.x === lastWinPos.x && origin.y === lastWinPos.y) return;
    lastCursor = { x: pt.x, y: pt.y };
    lastWinPos = origin;

    // 拖拽中强制保持可交互
    if (dragging) { apply(false); return; }

    const inside = pt.x >= origin.x && pt.x < origin.x + b.width &&
                   pt.y >= origin.y && pt.y < origin.y + b.height;

    if (!inside) {
      apply(true); // 鼠标在窗口外：必须穿透，否则会挡住旁边窗口
      return;
    }

    const hit = hitTest(pt.x - origin.x, pt.y - origin.y);
    stats.probes++;
    stats.lastProbe = { screenX: pt.x, screenY: pt.y, offsetX: pt.x - origin.x, offsetY: pt.y - origin.y, hit };
    if (hit) stats.hits++; else stats.misses++;
    apply(!hit);
    lastHit = hit;
  }

  const timer = setInterval(probe, POLL_MS);
  timer.unref?.();

  // 渲染层的鼠标反馈（比轮询快，用来即时响应）
  const { ipcMain } = require('electron');
  const onPointer = (_e, payload) => {
    if (!payload || dragging) return;
    const hit = !!payload.hit;
    apply(!hit);
    lastHit = hit;
  };
  ipcMain.on('pet:pointer-hit', onPointer);

  const onDragStart = (_e, payload) => {
    if (!payload) return;
    dragging = true;
    apply(false);
    const { screen } = require('electron');
    // 关键：窗口尺寸必须用"设计逻辑尺寸"，不能回写 getBounds() 的结果。
    // Windows 高 DPI 下 getBounds() 返回的是被吸到物理像素网格的值（200 → 204），
    // 若每次拖动都把它当原尺寸回写，误差会一轮轮累积，窗口会越拖越大。
    const b0 = win.getBounds();
    const designW = payload.winW || b0.width;
    const designH = payload.winH || b0.height;
    win.__dragState = {
      offX: payload.cursorX - payload.winX,
      offY: payload.cursorY - payload.winY,
      designW,
      designH,
      dryRun: !!payload.dryRun,
      timer: null,
    };
    if (win.__dragState.dryRun) return; // 自检用：只验链路，绝不搬动窗口
    win.__dragState.timer = setInterval(() => {
      if (!dragging || !win || win.isDestroyed()) return;
      const pt = screen.getCursorScreenPoint();
      win.setBounds({
        x: Math.round(pt.x - win.__dragState.offX),
        y: Math.round(pt.y - win.__dragState.offY),
        width: win.__dragState.designW,
        height: win.__dragState.designH,
      });
    }, 12);
    win.__dragState.timer.unref?.();
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (win.__dragState?.timer) clearInterval(win.__dragState.timer);
    const wasDry = !!win.__dragState?.dryRun;
    win.__dragState = null;
    lastCursor = { x: -1, y: -1 }; // 强制下一轮重新判定
    if (!wasDry) probe();
  };
  ipcMain.on('pet:drag-end', endDrag);
  ipcMain.on('pet:drag-start', onDragStart);

  async function refreshMask() {
    if (!win || win.isDestroyed()) return null;
    // 生成掩码时要冻结动画、藏起气泡，否则掩码会带上动画相位和气泡的残影
    await win.webContents.insertCSS(
      '*, *::before, *::after { animation-play-state: paused !important; } #bubble { visibility: hidden !important; }'
    ).catch(() => null);
    await new Promise((r) => setTimeout(r, 120));
    const image = await win.webContents.capturePage();
    const b = win.getBounds();
    mask = buildMaskFromNativeImage(image, b.width, b.height, 0);
    stats.maskCoverage = mask.coverage;
    stats.maskPhysical = mask.physical;
    return mask;
  }

  function dispose() {
    clearInterval(timer);
    ipcMain.removeListener('pet:pointer-hit', onPointer);
    ipcMain.removeListener('pet:drag-start', onDragStart);
    ipcMain.removeListener('pet:drag-end', endDrag);
    if (win.__dragState?.timer) clearInterval(win.__dragState.timer);
  }

  return {
    refreshMask,
    dispose,
    probe,
    hitTest,
    getState: () => ({ ignoring, dragging, maskReady: !!mask, lastHit, stats }),
    // 自检/探针用：强制设定穿透态，以便外部（Win32 探针）读取窗口样式验证真的生效了
    forceIgnore: (on) => { apply(!!on); return ignoring; },
    // 自检用：完整走一遍拖动位置计算，但 dryRun 保证不真的搬动窗口。
    // 用来验证"反复拖动不会让窗口累积变大"这个坑。
    simulateDragEnd: () => {
      const state = win.__dragState;
      if (!state) return null;
      const pt = require('electron').screen.getCursorScreenPoint();
      const target = {
        x: Math.round(pt.x - state.offX),
        y: Math.round(pt.y - state.offY),
        width: state.designW,
        height: state.designH,
      };
      if (!state.dryRun) win.setBounds(target);
      return { target, applied: !state.dryRun };
    },
    // 自检用：直接按屏幕坐标试一次命中判定（不改真实状态，避免自检搅乱体验）
    testPoint: (screenX, screenY) => {
      const origin = windowOrigin();
      const b = win.getBounds();
      const inside = screenX >= origin.x && screenX < origin.x + b.width &&
                     screenY >= origin.y && screenY < origin.y + b.height;
      if (!inside) return { inside: false, hit: null, wouldIgnore: true };
      const hit = hitTest(screenX - origin.x, screenY - origin.y);
      return { inside: true, hit, wouldIgnore: !hit, offsetX: screenX - origin.x, offsetY: screenY - origin.y };
    },
  };
}

module.exports = { installClickThrough, buildMaskFromNativeImage, ALPHA_THRESHOLD, DOWNSCALE };
