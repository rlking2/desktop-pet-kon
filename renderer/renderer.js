// 鲸鱼娘桌宠 · 渲染层互动逻辑（无 Node 权限，只经 preload 暴露的 API）
(() => {
  const pet = document.getElementById('pet');
  const bubble = document.getElementById('bubble');
  const dbg = document.getElementById('dbg');

  const CLICK_LINES = [
    '主人戳人家干嘛啦！',
    '哼，人家才不是闲着没事做呢。',
    '今日白饭余额：不多了……主人该喂了。',
    '这个 DDL 人家看了一眼，先不看第二眼。',
    '（甩尾鳍）人家在的哦。',
    '摸鱼第 3 分钟，主人别举报人家。',
  ];
  const PAT_LINES = [
    '呜……别、别摸头啦，头发会乱掉的。',
    '人、人家才没有很舒服呢！',
    '（耳朵尾巴都软了）就、就一下下哦。',
  ];
  const ANGRY_LINES = [
    '人！家！不！胖！是深海蓝的视觉误差！',
    '主人再说那个字，人家就罢工了！',
    '（鼓腮）尾鳍大是鲸鱼的特征，懂不懂啊！',
  ];
  const RICE_LINES = [
    '白饭！是白饭！主人最好了！',
    '（扒饭）token 香香的……再来一碗。',
    '这碗白饭人家记在小本本上了，会还的。',
  ];

  let bubbleTimer = null;
  let sayCount = 0;
  function say(text, ms = 2600) {
    sayCount++;
    bubble.textContent = text;
    bubble.classList.add('show');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }

  let animTimer = null;
  function playAnim(name, ms) {
    pet.classList.remove('hop', 'pat', 'angry');
    // 强制重排，保证同类动画能重复触发
    void pet.offsetWidth;
    pet.classList.add(name);
    clearTimeout(animTimer);
    animTimer = setTimeout(() => pet.classList.remove(name), ms);
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  let rice = 0;

  // ---------- 鼠标穿透：实时上报鼠标是否落在"实体"上 ----------
  // 用 elementFromPoint 判断，比数学掩码更贴合实际 DOM（SVG 透明区域不会误判为实体）
  let lastHit = null;
  let lastMoveAt = 0;
  function reportHit(x, y) {
    const now = performance.now();
    if (now - lastMoveAt < 16) return; // 限到 ~60fps，省 IPC
    lastMoveAt = now;
    const el = document.elementFromPoint(x, y);
    const hit = !!(el && pet.contains(el));
    if (hit === lastHit) return;
    lastHit = hit;
    window.pet.pointerHit(hit);
  }

  window.addEventListener('mousemove', (e) => reportHit(e.clientX, e.clientY));
  window.addEventListener('mouseleave', () => {
    if (lastHit !== false) { lastHit = false; window.pet.pointerHit(false); }
  });

  // ---------- 手动拖动 ----------
  // 三个必须遵守的约束（都是踩坑换来的，见 devlog round-03）：
  // 1) 不能在 mousedown 里 await getBounds() 再启动拖动 —— 真人快速点击时 mouseup 先到，
  //    拖动循环会被漏关，窗口永久粘在鼠标上。
  // 2) 不能在 mousedown 里 preventDefault() —— Chromium 会因此抑制 contextmenu 事件。
  // 3) 必须等鼠标真的移动超过阈值（DRAG_THRESHOLD）才开始拖动 —— 否则点一下的细微抖动
  //    也会让窗口跟着微动，按下/抬起落在不同坐标，click 事件同样不会产生。
  const DRAG_THRESHOLD = 4; // 逻辑像素
  let pendingDrag = null;   // { x, y } 按下起点（屏幕坐标）
  let dragging = false;

  pet.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pendingDrag = { x: Math.round(e.screenX), y: Math.round(e.screenY) };
  });

  window.addEventListener('mousemove', (e) => {
    if (!pendingDrag || dragging) return;
    const dx = Math.round(e.screenX) - pendingDrag.x;
    const dy = Math.round(e.screenY) - pendingDrag.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return; // 还只是手抖，不算拖动
    dragging = true;
    pet.classList.add('dragging');
    window.pet.dragStart({
      cursorX: Math.round(e.screenX),
      cursorY: Math.round(e.screenY),
    });
  });

  const stopDrag = () => {
    pendingDrag = null;
    if (!dragging) return;
    dragging = false;
    pet.classList.remove('dragging');
    window.pet.dragEnd();
  };
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('blur', stopDrag);
  window.addEventListener('mouseleave', stopDrag);

  pet.addEventListener('click', () => {
    say(pick(CLICK_LINES));
    playAnim('hop', 520);
  });

  // 摸头 / 喂饭 / 生气：由右键菜单或主人台词触发
  window.pet.onAction((name) => {
    if (name === 'headpat') { say(pick(PAT_LINES)); playAnim('pat', 720); return; }
    if (name === 'rice') {
      rice += 1;
      say(`${pick(RICE_LINES)}\n（今日已吃 ${rice} 碗白饭）`, 3200);
      playAnim('hop', 520);
      return;
    }
    if (name === 'angry') { say(pick(ANGRY_LINES)); playAnim('angry', 1300); return; }
  });

  window.pet.onSay((text) => say(text, 3000));
  window.pet.onDebugOverlay((on) => dbg.classList.toggle('on', !!on));
  // 自检专用通道：直接下达穿透开关，用来验证 OS 层窗口状态
  window.pet.onForceHit((hit) => { lastHit = hit; window.pet.pointerHit(hit); });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.__petContextMenuCount = (window.__petContextMenuCount || 0) + 1;
    window.__petContextMenuFrom = (e.target && e.target.tagName ? e.target.tagName : '?') +
      (e.target && e.target.id ? '#' + e.target.id : '');
    window.pet.openContextMenu();
  });

  // 自检用：把 renderer 里真实发生的点击链记录下来（自动 click() 不触发 mousedown，所以必须记真事件）
  let clickCount = 0;
  pet.addEventListener('click', () => { clickCount++; });

  // ---- 右键诊断：把"物理右键事件到底有没有进来"暴露给主进程 ----
  // 真人反馈过右键无效。合成事件能通过、物理右键不一定，必须留下可读的现场记录。
  const rightDiag = { mousedown: 0, mouseup: 0, contextmenu: 0, lastAt: null, lastTarget: null };
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) { rightDiag.mousedown++; rightDiag.lastAt = Date.now(); rightDiag.lastTarget = e.target?.tagName; }
  }, true);
  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) rightDiag.mouseup++;
  }, true);
  window.addEventListener('contextmenu', (e) => {
    rightDiag.contextmenu++;
  }, true);
  window.__petRightDiag = rightDiag;

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.pet.quit();
    // 兜底入口：万一物理右键因为平台原因进不来，用 Ctrl+M 照样能开菜单
    if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      window.__petContextMenuCount = (window.__petContextMenuCount || 0) + 1;
      window.__petContextMenuFrom = 'keyboard';
      window.pet.openContextMenu();
    }
  });

  // 自检用：把交互能力暴露成一个可调用入口，让人家能自动验证
  window.__petTest = {
    click: () => pet.click(),
    action: (n) => {
      if (n === 'headpat') { say(pick(PAT_LINES)); playAnim('pat', 720); }
      if (n === 'angry') { say(pick(ANGRY_LINES)); playAnim('angry', 1300); }
    },
    // 模拟鼠标移动，验证穿透上报逻辑
    probeHit: (x, y) => {
      const el = document.elementFromPoint(x, y);
      const hit = !!(el && pet.contains(el));
      lastHit = hit;
      window.pet.pointerHit(hit);
      return { hit, element: el ? (el.tagName + (el.id ? '#' + el.id : '')) : null };
    },
    // 模拟拖动开始/结束，验证手动拖动链路。dryRun=true 时主进程只走链路、绝不搬动窗口，
    // 避免自检把主人的桌宠挪到屏幕中间去。
    dragSimulate: async () => {
      const bounds = await window.pet.getBounds();
      window.pet.dragStart({
        cursorX: bounds.x + Math.round(bounds.width / 2),
        cursorY: bounds.y + Math.round(bounds.height / 2),
        winX: bounds.x,
        winY: bounds.y,
        winW: 200,
        winH: 250,
        dryRun: true,
      });
      await new Promise((r) => setTimeout(r, 120));
      window.pet.dragEnd();
      return { bounds, ok: true };
    },    // 真实事件链测试：模拟真人的 mousedown → mouseup → click（自动 click() 不走 mousedown，
    // 所以旧版测试根本覆盖不到拖动 race）
    realClick: () => {
      const r = pet.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const sx = Math.round(window.screenX + x);
      const sy = Math.round(window.screenY + y);
      const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: sx, screenY: sy, button: 0, detail: 1 };
      pet.dispatchEvent(new MouseEvent('mousedown', opts));
      window.dispatchEvent(new MouseEvent('mouseup', opts));
      pet.dispatchEvent(new MouseEvent('click', opts));
      return { clickCount, dragging };
    },
    // 真实拖动链：mousedown → 移动超过阈值 → 拖动启动 → mouseup 结束
    realDrag: async (movePx) => {
      const r = pet.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, button: 0, detail: 1 };
      const sx = Math.round(window.screenX + x);
      const sy = Math.round(window.screenY + y);
      pet.dispatchEvent(new MouseEvent('mousedown', { ...base, clientX: x, clientY: y, screenX: sx, screenY: sy }));
      const m = movePx || 30;
      window.dispatchEvent(new MouseEvent('mousemove',
        { ...base, clientX: x + m, clientY: y + m, screenX: sx + m, screenY: sy + m }));
      await new Promise((res) => setTimeout(res, 120));
      const draggingDuring = dragging;
      window.dispatchEvent(new MouseEvent('mouseup',
        { ...base, clientX: x + m, clientY: y + m, screenX: sx + m, screenY: sy + m }));
      return { draggingDuring, draggingAfter: dragging };
    },
    // 复现主人的真实场景：点一下时鼠标有轻微移动（真人不可能绝对静止）。
    // 窗口跟着鼠标微动 → 按下和抬起落在不同坐标 → Chromium 不产生 click。
    realClickWithJitter: (jitterPx) => {
      const before = { say: sayCount, click: clickCount };
      const r = pet.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, button: 0, detail: 1 };
      pet.dispatchEvent(new MouseEvent('mousedown',
        { ...base, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y }));
      const j = jitterPx || 0;
      window.dispatchEvent(new MouseEvent('mouseup',
        { ...base, clientX: x + j, clientY: y + j, screenX: window.screenX + x + j, screenY: window.screenY + y + j }));
      pet.dispatchEvent(new MouseEvent('click',
        { ...base, clientX: x + j, clientY: y + j, screenX: window.screenX + x + j, screenY: window.screenY + y + j }));
      return { sayDelta: sayCount - before.say, clickDelta: clickCount - before.click, jitter: j };
    },
    // 真实右键链：走 window 上的 contextmenu 处理器
    realContextMenu: () => {
      const before = window.__petContextMenuCount || 0;
      const r = pet.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const ev = new MouseEvent('contextmenu', opts);
      const notCancelled = pet.dispatchEvent(ev);
      return {
        fired: (window.__petContextMenuCount || 0) > before,
        count: window.__petContextMenuCount || 0,
        from: window.__petContextMenuFrom || null,
        defaultPrevented: ev.defaultPrevented,
        notCancelled,
      };
    },
    // 兜底入口测试：模拟 Ctrl+M
    keyboardMenu: () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true }));
      return { count: window.__petContextMenuCount || 0, from: window.__petContextMenuFrom || null };
    },
    state: () => ({
      petClasses: pet.className,
      bubbleShown: bubble.classList.contains('show'),
      bubbleText: bubble.textContent,
      lastHit,
      clickCount,
      sayCount,
      dragging,
      contextMenuCount: window.__petContextMenuCount || 0,
      rightDiag: { ...rightDiag },
    }),
  };

  console.log('[鲸鱼娘] 桌宠已就位，尾鳍在线。');
})();
