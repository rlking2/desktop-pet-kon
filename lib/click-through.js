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

function installClickThrough(win, { buildMask, onRightClick, onPointerOutside } = {}) {
  let mask = null;
  let ignoring = null;      // null = 还没设过
  let dragging = false;
  let wasInside = false;    // 鼠标上一次是否在窗口内（用于"离开窗口"的边沿检测）
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

    // 记录"鼠标离开窗口"的边沿，用于待办面板的"点区域外自动关闭"。
    // 为什么需要：窗口是透明的，鼠标移出窗口后点击会**穿透到桌面**，
    // 渲染层根本收不到事件；只有主进程知道鼠标已经出去了。
    if (!inside && wasInside) {
      wasInside = false;
      if (typeof onPointerOutside === 'function') {
        try { onPointerOutside(); } catch { /* 忽略 */ }
      }
    } else if (inside && !wasInside) {
      wasInside = true;
    }

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
    // ---- 尺寸防漂移（round-04 深挖） ----
    // Windows 在高 DPI 下把窗口尺寸吸附到整数物理像素网格。150% 缩放时 254 逻辑像素
    // (=381 物理) 会被吸成 255 逻辑 (=382.5→383)，所以"读回来再写回去"每拖一次就 +1px。
    // 修法：锁存第一次拿到的"设计尺寸"，之后一直用它；并做物理像素量化补偿，
    //      让目标尺寸吸附回同一个物理网格点，从而彻底消除累积漂移。
    if (!win.__designSize) win.__designSize = { w: b0.width, h: b0.height };
    const designW = payload.winW || win.__designSize.w;
    const designH = payload.winH || win.__designSize.h;
    win.__designSize = { w: designW, h: designH };
    // 取一个把设计尺寸自己吸回去的物理网格点（自愈：写回后读数应与设计值一致）
    const sf = require('electron').screen.getDisplayMatching(b0).scaleFactor || 1;
    const physW = Math.round(designW * sf);
    const physH = Math.round(designH * sf);
    const quantW = designW <= 0 ? designW : Math.ceil(physW / sf);
    const quantH = designH <= 0 ? designH : Math.ceil(physH / sf);
    // 偏移在主进程算：mousedown 自带屏幕坐标，省掉一次 IPC 往返。
    // 往返是致命的——真人快速点击时 mouseup 会在往返完成前到达，拖动循环会被漏关（见 round-03）。
    const offX = payload.winX !== undefined ? payload.cursorX - payload.winX : payload.cursorX - b0.x;
    const offY = payload.winY !== undefined ? payload.cursorY - payload.winY : payload.cursorY - b0.y;
    win.__dragState = {
      offX,
      offY,
      designW: quantW,
      designH: quantH,
      dryRun: !!payload.dryRun,
      moves: 0,
      timer: null,
    };
    if (win.__dragState.dryRun) return; // 自检用：只验链路，绝不搬动窗口
    win.__dragState.timer = setInterval(() => {
      if (!dragging || !win || win.isDestroyed()) return;
      const pt = screen.getCursorScreenPoint();
      win.__dragState.moves++;
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
    // 生成掩码时必须把一切"辅助视觉"都藏起来，否则会被烧进掩码：
    //   - 动画要冻结（否则掩码带随机相位）
    //   - 气泡要藏（否则气泡区域变成实体，挡住桌面点击）
    //   - **调试边框 #dbg 更要藏**（否则整圈红框被当成实体，边缘一整条都无法穿透）
    //
    // ⚠️ 严重教训（round-04）：这里原本用 webContents.insertCSS()，而它**无法撤销**。
    //    生成一次掩码后 `#bubble { visibility: hidden !important }` 就永久生效，
    //    此后整个会话里气泡再也显示不出来 —— 症状是"点击有反应(处理器跑了、class 加了、
    //    opacity 也是 1)但屏幕上什么都看不到"。主人的反馈就是这个 bug。
    //    改成"根元素临时 class + 可移除的 <style>"，用完立刻还原，并记录还原结果供自检断言。
    const styleId = '__pet-mask-freeze-style';
    await win.webContents.executeJavaScript(`(() => {
      document.documentElement.classList.add('pet-mask-freeze');
      if (!document.getElementById('${styleId}')) {
        const s = document.createElement('style');
        s.id = '${styleId}';
        s.textContent =
          'html.pet-mask-freeze *, html.pet-mask-freeze *::before, html.pet-mask-freeze *::after { animation-play-state: paused !important; }' +
          'html.pet-mask-freeze #bubble { visibility: hidden !important; }' +
          'html.pet-mask-freeze #dbg { display: none !important; }';
        document.head.appendChild(s);
      }
      return true;
    })()`).catch(() => null);
    await new Promise((r) => setTimeout(r, 150));

    const image = await win.webContents.capturePage();
    const b = win.getBounds();
    mask = buildMaskFromNativeImage(image, b.width, b.height, 0);
    stats.maskCoverage = mask.coverage;
    stats.maskPhysical = mask.physical;
    stats.maskBbox = mask.bbox;

    // ★ 必须还原
    stats.maskRestore = await win.webContents.executeJavaScript(`(() => {
      document.documentElement.classList.remove('pet-mask-freeze');
      const s = document.getElementById('${styleId}');
      if (s) s.remove();
      const bubble = document.getElementById('bubble');
      return {
        freezeClassLeft: document.documentElement.classList.contains('pet-mask-freeze'),
        styleLeft: !!document.getElementById('${styleId}'),
        bubbleVisibility: bubble ? getComputedStyle(bubble).visibility : null,
      };
    })()`).catch(() => null);
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
    // 自检用：在掩码里精确找出一个"实体像素"的屏幕坐标（不靠粗网格碰运气）
    findSolidPoint: () => {
      if (!mask) return null;
      const b = win.getBounds();
      const mw = mask.mw, mh = mask.mh;
      const cx = Math.floor(mw / 2), cy = Math.floor(mh / 2);
      for (let r = 0; r < Math.max(mw, mh); r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // 只扫当前"环"
            const mx = cx + dx, my = cy + dy;
            if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
            if (mask.data[my * mw + mx] !== 1) continue;
            // 掩码坐标 → 物理像素 → 逻辑像素 → 屏幕坐标
            const physX = mx * DOWNSCALE + DOWNSCALE / 2;
            const physY = my * DOWNSCALE + DOWNSCALE / 2;
            const logicalX = Math.floor(physX / mask.scaleX);
            const logicalY = Math.floor(physY / mask.scaleY);
            return {
              maskX: mx, maskY: my, logicalX, logicalY,
              screenX: b.x + logicalX, screenY: b.y + logicalY,
            };
          }
        }
      }
      return null;
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
