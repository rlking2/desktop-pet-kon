// 桌宠 · 渲染层（通用机制，不含任何具体主题形象）
//
// 职责：
//   1. 把角色画到 canvas 上：有素材（assets/manifest.json）就播帧动画，没有就画一个"空位提示"
//   2. 互动：点击说话、右键菜单、按住拖动（手动实现，因为与逐像素穿透冲突）
//   3. 鼠标穿透上报：告诉主进程"鼠标现在落在实体上还是空气里"
//   4. 诊断：把真实鼠标事件写进原始输入日志（排查"真人操作无效"用）
//
// 形象完全由素材决定，代码里不写死任何主题（配色/台词/名牌都由素材与配置决定）。
(() => {
  const pet = document.getElementById('pet');
  const bubble = document.getElementById('bubble');
  const dbg = document.getElementById('dbg');
  const sceneEl = document.querySelector('.scene');

  // ---------- 原始输入日志 ----------
  const diagQueue = [];
  let diagFlush = null;
  function dlog(type, detail) {
    diagQueue.push({ src: 'renderer', type, detail });
    if (diagQueue.length >= 25) return flushDiag();
    if (!diagFlush) diagFlush = setTimeout(flushDiag, 150);
  }
  function flushDiag() {
    if (diagFlush) { clearTimeout(diagFlush); diagFlush = null; }
    if (!diagQueue.length) return;
    const batch = diagQueue.splice(0, diagQueue.length);
    try { window.pet.diag(batch); } catch { /* 诊断失败不该影响桌宠 */ }
  }
  const describeTarget = (t) => (t && t.tagName ? t.tagName : '?') + (t && t.id ? '#' + t.id : '');
  window.addEventListener('beforeunload', flushDiag);

  const MOUSE_EVENTS = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'mouseleave', 'mouseenter'];
  for (const type of MOUSE_EVENTS) {
    window.addEventListener(type, (e) => {
      dlog(type, `target=${describeTarget(e.target)} button=${e.button} detail=${e.detail} ` +
        `client=(${Math.round(e.clientX)},${Math.round(e.clientY)}) screen=(${Math.round(e.screenX)},${Math.round(e.screenY)}) ` +
        `defaultPrevented=${e.defaultPrevented}`);
    }, true);
  }
  let lastMoveLog = 0;
  window.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMoveLog < 300) return;
    lastMoveLog = now;
    dlog('mousemove', `client=(${Math.round(e.clientX)},${Math.round(e.clientY)}) target=${describeTarget(e.target)}`);
  }, true);

  // ---------- 台词（中性，与主题无关；以后可由素材包或配置覆盖） ----------
  const LINES = {
    click: ['戳人家干嘛啦。', '在的在的。', '人家醒着呢。', '今日状态：还行。'],
    pat: ['唔……别摸啦。', '就、就一下哦。', '（眯眼）'],
    angry: ['哼！不理你了。', '再说人家就罢工了！', '（鼓起来）'],
    rice: ['谢谢！', '收到，能量+1。', '这个人家记下了。'],
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- 气泡 ----------
  let bubbleTimer = null;
  let sayCount = 0;
  let audioCtx = null;
  function chirp(freq = 880) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      if (!audioCtx) audioCtx = new Ctx();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, t + 0.09);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.14);
      return true;
    } catch { return false; }
  }
  function say(text, ms = 2600) {
    sayCount++;
    bubble.textContent = text;
    bubble.classList.add('show');
    chirp();
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), ms);
  }

  // ---------- 互动形变（缺素材时的兜底表现） ----------
  let animTimer = null;
  function playAnim(name, ms) {
    pet.classList.remove('hop', 'pat', 'angry');
    void pet.offsetWidth; // 强制重排，保证同类动画能重复触发
    pet.classList.add(name);
    clearTimeout(animTimer);
    animTimer = setTimeout(() => pet.classList.remove(name), ms);
  }

  // ---------- 待办面板 ----------
  // 需求：左键点击桌宠 → 展开待办面板。顶部输入栏，下方两列网格，**默认可见 5 栏**；
  //       每个栏位左侧一个小方框，点击即"完成并删除该栏"。
  //       任务超过 5 条时，**网格区域自动变可滚动**（面板尺寸不变，避免窗口跟着抖）。
  const MEMO_VISIBLE = 5;   // 默认可见栏数（2 列 × 3 行 = 6 格，第 6 格是空槽）
  const MEMO_KEY = 'desktopPet.memo.tasks';
  const memoEl = document.getElementById('memo');
  const memoList = document.getElementById('memoList');
  const memoScroll = document.getElementById('memoScroll');
  const memoInput = document.getElementById('memoInput');
  const memoCountEl = document.getElementById('memoCount');
  const memoCapEl = document.getElementById('memoCap');
  const memoFoot = document.getElementById('memoFoot');
  const memoClose = document.getElementById('memoClose');
  if (memoCapEl) memoCapEl.textContent = String(MEMO_VISIBLE);

  const memoState = { open: false, tasks: [], renders: 0, removed: 0, added: 0, opens: 0, closes: 0, scrollable: false };
  let panelSide = null;

  function loadTasks() {
    try {
      const raw = localStorage.getItem(MEMO_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      // 不再限制条数：超过可见栏数时靠滚动查看
      memoState.tasks = Array.isArray(arr) ? arr.filter((t) => t && typeof t.text === 'string') : [];
    } catch { memoState.tasks = []; }
  }
  function saveTasks() {
    try { localStorage.setItem(MEMO_KEY, JSON.stringify(memoState.tasks)); } catch { /* 存不下就算了，不影响使用 */ }
  }
  function setFoot(msg) { if (memoFoot) memoFoot.textContent = msg || ''; }

  function renderMemo() {
    if (!memoList) return;
    memoState.renders++;
    memoList.innerHTML = '';
    const taskCount = memoState.tasks.length;
    // 槽位数：至少撑满"默认可见 5 栏"，奇数条时补一个空槽凑齐两列
    const slots = Math.max(MEMO_VISIBLE + (taskCount >= MEMO_VISIBLE ? 1 : 0), taskCount + (taskCount % 2));
    for (let i = 0; i < slots; i++) {
      const task = memoState.tasks[i];
      const row = document.createElement('div');
      row.className = 'memo-item' + (task ? '' : ' empty');
      const box = document.createElement('button');
      box.className = 'memo-box';
      box.type = 'button';
      box.setAttribute('aria-label', task ? `完成并删除：${task.text}` : '空栏位');
      const span = document.createElement('span');
      span.className = 'memo-text';
      span.textContent = task ? task.text : '空';
      if (task) {
        box.addEventListener('click', (ev) => {
          ev.stopPropagation();
          completeTask(i);
        });
      } else {
        box.disabled = true;
      }
      row.appendChild(box);
      row.appendChild(span);
      memoList.appendChild(row);
    }
    if (memoCountEl) memoCountEl.textContent = String(taskCount);

    // 是否出现滚动条：用真实布局数据判断（比算公式可靠）
    const sc = memoScroll || memoList; // 滚动发生在外层容器上，不是 grid 本身
    const scrollable = sc.scrollHeight > sc.clientHeight + 1;
    memoState.scrollable = scrollable;
    if (memoEl) memoEl.classList.toggle('scrollable', scrollable);

    const left = Math.max(0, MEMO_VISIBLE - taskCount);
    if (scrollable) {
      setFoot(`共 ${taskCount} 条 · 向上滚动查看更多`);
    } else if (left > 0) {
      setFoot(`还可以添加 ${left} 条`);
    } else {
      setFoot('满 5 条后继续添加会自动滚动');
    }
    return { slots, scrollable };
  }

  function addTask(text) {
    const t = String(text || '').trim();
    if (!t) return false;
    memoState.tasks.push({ text: t, createdAt: Date.now() });
    memoState.added++;
    saveTasks();
    const r = renderMemo();
    // 新任务如果落在滚动区之外，自动滚到底让主人看见
    if (memoScroll && r && r.scrollable) memoScroll.scrollTop = memoScroll.scrollHeight;
    setFoot(r && r.scrollable ? `已添加 · 共 ${memoState.tasks.length} 条` : '已添加');
    return true;
  }

  function completeTask(index) {
    const task = memoState.tasks[index];
    if (!task) return false;
    // 先在界面上标记"完成"，让主人看到反馈，再删除并重排
    const rows = memoList ? memoList.querySelectorAll('.memo-item') : [];
    const row = rows[index];
    if (row) {
      row.classList.add('done');
      const box = row.querySelector('.memo-box');
      if (box) box.classList.add('done-check');
    }
    const label = task.text;
    setTimeout(() => {
      memoState.tasks.splice(index, 1);
      memoState.removed++;
      saveTasks();
      renderMemo();
      setFoot(`已完成：${label}`);
    }, 220);
    return true;
  }

  function requestPanelSize(open) {
    try { return window.pet.setPanel(open); } catch (err) { dlog('memo', '请求面板尺寸失败: ' + (err && err.message)); return null; }
  }

  // 主进程算完"面板放哪边"会回传，渲染层据此调整布局
  // 默认（.memo-open 不带 panel-right）就是"面板在左、桌宠在右"→ 窗口向左扩展、桌宠不动
  window.pet.onPanelSide((side) => {
    panelSide = side || null;
    sceneEl.classList.toggle('panel-right', side === 'right');
    dlog('memo', `面板布局：${side === 'right' ? '窗口向右扩展，桌宠靠左' : '窗口向左扩展，桌宠靠右（位置不变）'}`);
  });

  function openMemo() {
    if (memoState.open) return false;
    memoState.open = true;
    memoState.opens++;
    if (memoEl) { memoEl.classList.add('show'); memoEl.setAttribute('aria-hidden', 'false'); }
    sceneEl.classList.add('memo-open');
    renderMemo();
    requestPanelSize(true);
    // 让键盘焦点落到输入框（面板要能打字），同时把窗口提到可交互层
    try { window.pet.focusWindow(); } catch { /* 忽略 */ }
    setTimeout(() => { if (memoInput) memoInput.focus(); }, 120);
    dlog('memo', `面板展开，当前 ${memoState.tasks.length} 条（默认可见 ${MEMO_VISIBLE} 栏，超出滚动）`);
    return true;
  }

  function closeMemo() {
    if (!memoState.open) return false;
    memoState.open = false;
    memoState.closes++;
    if (memoEl) { memoEl.classList.remove('show'); memoEl.setAttribute('aria-hidden', 'true'); }
    sceneEl.classList.remove('memo-open');
    if (memoInput) memoInput.value = '';
    requestPanelSize(false);
    dlog('memo', '面板收起');
    return true;
  }

  function toggleMemo() { return memoState.open ? closeMemo() : openMemo(); }

  if (memoInput) {
    memoInput.addEventListener('keydown', (e) => {
      e.stopPropagation(); // 别让 Esc 之类冒泡到全局快捷键
      if (e.key === 'Enter') {
        addTask(memoInput.value);
        memoInput.value = '';
      } else if (e.key === 'Escape') {
        closeMemo();
      }
    });
  }
  if (memoClose) memoClose.addEventListener('click', closeMemo);
  loadTasks();
  renderMemo();

  // ---------- 气泡自动翻面（窗口贴屏幕顶部时改从下方弹出） ----------
  let flipShown = null;
  function updateFlip() {
    const topSpace = window.screenY;
    const shouldFlip = topSpace < 70;
    if (shouldFlip === flipShown) return;
    flipShown = shouldFlip;
    sceneEl.classList.toggle('flip', shouldFlip);
    dlog('bubble-flip', `窗口上方空间=${topSpace}px → 气泡在${shouldFlip ? '下方' : '上方'}`);
  }
  updateFlip();
  window.addEventListener('mousemove', updateFlip);
  setInterval(updateFlip, 500);

  // ---------- 鼠标穿透上报 ----------
  let lastHit = null;
  let lastMoveAt = 0;
  function reportHit(x, y) {
    const now = performance.now();
    if (now - lastMoveAt < 16) return;
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
    if (hoverState.active) setHover(false);
  });

  // ---------- 鼠标靠近 ----------
  // 主人明确说"点击功能已经被占用"（左键=待办面板），所以"靠近"用**鼠标移入角色矩形**触发：
  //   进入 → 若 assets/hover 有素材就播一次（1 帧素材就是"停在这一帧"）
  //   离开 → 回待机
  // 用矩形判定即可（角色就是矩形的），不必做逐像素 alpha 判定。
  function setHover(on) {
    if (on === hoverState.active) return;
    hoverState.active = on;
    spriteState.hovering = on;
    if (on) hoverState.enters++; else hoverState.exits++;
    if (!spriteState.available) { dlog('hover', `靠近=${on}（无素材，忽略）`); return; }
    if (on) {
      if (spriteGroups.hover) {
        // 一次性播完 → onEnd 里会判断"鼠标还在不在"决定停在 hover 还是回 idle
        playGroup('hover', { loop: false, force: true, onEnd: () => backToIdle('hover 播完') });
      } else {
        dlog('hover', '靠近了，但没有 hover 素材，保持待机');
      }
    } else {
      const base = spriteState.baseGroup;
      if (spriteGroups[base]) playGroup(base, { loop: true, force: true });
    }
  }

  window.addEventListener('mousemove', (e) => {
    if (!spriteState.available) return;
    const r = pet.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    setHover(inside);
  });

  // ---------- 手动拖动 ----------
  // 三条铁律（踩坑换来的，见 devlog）：
  //  1) 不能在 mousedown 里 await getBounds() 再启动拖动 —— 快速点击时 mouseup 先到，拖动循环会漏关
  //  2) 不能在 mousedown 里 preventDefault() —— Chromium 会因此抑制 contextmenu
  //  3) 必须有移动阈值 —— 否则点一下的微抖动让窗口跟着动，click 事件不会产生
  const DRAG_THRESHOLD = 4;
  let pendingDrag = null;
  let dragging = false;

  pet.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pendingDrag = { x: Math.round(e.screenX), y: Math.round(e.screenY) };
    dlog('drag-armed', `按下起点(屏幕)=(${pendingDrag.x},${pendingDrag.y})，等移动超过 ${DRAG_THRESHOLD}px`);
  });

  window.addEventListener('mousemove', (e) => {
    if (!pendingDrag || dragging) return;
    const dx = Math.round(e.screenX) - pendingDrag.x;
    const dy = Math.round(e.screenY) - pendingDrag.y;
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    dragging = true;
    pet.classList.add('dragging');
    dlog('drag-start', `位移=(${dx},${dy}) 超过阈值，开始拖动`);
    window.pet.dragStart({ cursorX: Math.round(e.screenX), cursorY: Math.round(e.screenY) });
  });

  const stopDrag = () => {
    pendingDrag = null;
    if (!dragging) return;
    dragging = false;
    pet.classList.remove('dragging');
    dlog('drag-end', '拖动结束');
    window.pet.dragEnd();
  };
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('blur', stopDrag);
  window.addEventListener('mouseleave', stopDrag);

  // 左键点击 = 展开/收起待办面板（原来的"随机台词"已被面板替换）
  pet.addEventListener('click', () => {
    toggleMemo();
  });

  // ---------- 右键 / 按键 ----------
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.__petContextMenuCount = (window.__petContextMenuCount || 0) + 1;
    window.__petContextMenuFrom = describeTarget(e.target);
    window.pet.openContextMenu();
  });

  // 键盘全局快捷键：注册在**冒泡阶段**（不要用捕获阶段）。
  // 面板打开时输入框会 stopPropagation 来接管键盘，而它只能阻止冒泡，挡不住捕获阶段。
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.pet.quit();
    if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      window.__petContextMenuCount = (window.__petContextMenuCount || 0) + 1;
      window.__petContextMenuFrom = 'keyboard';
      window.pet.openContextMenu();
    }
  });

  window.pet.onSay((text) => say(text, 3000));
  window.pet.onDebugOverlay((on) => dbg.classList.toggle('on', !!on));
  window.pet.onForceHit((hit) => { lastHit = hit; window.pet.pointerHit(hit); });

  window.pet.onAction((name) => {
    if (name === 'headpat') {
      say(pick(LINES.pat));
      if (!playAction('pet', ['headpat', 'pat'])) playAnim('pat', 720);
      return;
    }
    if (name === 'rice') {
      rice += 1;
      say(`${pick(LINES.rice)}\n（已投喂 ${rice} 次）`, 3200);
      if (!playAction('happy', ['hop', 'eat'])) playAnim('hop', 520);
      return;
    }
    if (name === 'angry') {
      say(pick(LINES.angry));
      if (!playAction('angry')) playAnim('angry', 1300);
      return;
    }
  });
  let rice = 0;

  // ---------- 角色渲染：帧动画 / 空位提示 ----------
  const canvas = document.getElementById('sprite');
  const ctx = canvas ? canvas.getContext('2d') : null;
  // 显示框尺寸由"素材真实宽高比"决定（竖构图素材 → 竖矩形显示区，人物更大更清晰）。
  // 主人在 2026-09 明确要求"改成贴合图片的竖矩形"，所以这里不再写死正方形。
  const DISP_H = 200;                 // 显示高度固定 200（窗口高度够）
  const DISP_W_MAX = 200;             // 兜底上限
  let CW = canvas ? canvas.width : 130;
  let CH = canvas ? canvas.height : 130;
  const spriteGroups = {};
  // 动作时间线。onEnd 回调就是"状态机"：
  //   idle → hold（一直循环）
  //   一次性动作（interact 交互 / hover 靠近）→ 到 idle（若鼠标还在角色上则停在 hover）
  const spriteTimeline = { name: null, loop: true, onEnd: null };
  const spriteState = {
    available: false, reason: '未加载', groups: [], baseGroup: null,
    activeGroup: null, activeFrame: 0, drewFrames: 0, placeholder: false, hovering: false,
  };
  const PRIORITY = { pet: 3, angry: 2, happy: 1, idle: 0 };
  // 鼠标靠近状态（放在前面声明：mousemove 处理器在初始化阶段就可能调用 setHover，
  // 而 setHover 在下面才定义；用 const 声明在后面会踩 TDZ 的坑）
  const hoverState = { active: false, enters: 0, exits: 0 };

  // 空位提示：没有素材时画一个中性的"占位环"，保证桌宠仍然可见、可点、可拖、
  // 穿透掩码也有实体可依（否则整个窗口都是空气，鼠标事件根本进不来）。
  function drawPlaceholder(t) {
    if (!ctx) return;
    const cx = CW / 2, cy = CH / 2;
    const pulse = 1 + Math.sin(t / 700) * 0.025;
    const r = 42 * pulse;
    ctx.clearRect(0, 0, CW, CH);

    // 淡填充：既让"实体区域"足够大（可点可拖、穿透掩码有效），又不会抢眼。
    // alpha 要够高才能通过穿透掩码的阈值（ALPHA_THRESHOLD=90/255≈0.35），
    // 否则"环内"会被判为空气、鼠标穿过去点不到桌宠。
    ctx.save();
    const grad = ctx.createRadialGradient(cx, cy, r * 0.15, cx, cy, r);
    grad.addColorStop(0, 'rgba(158, 176, 194, 0.55)');
    grad.addColorStop(0.75, 'rgba(158, 176, 194, 0.42)');
    grad.addColorStop(1, 'rgba(158, 176, 194, 0.18)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.strokeStyle = 'rgba(150, 170, 190, 0.95)';
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 7]);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = 'rgba(38, 52, 66, 0.92)';
    ctx.font = 'bold 13px "Microsoft YaHei UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('等待素材', cx, cy - 8);
    ctx.font = '10px "Microsoft YaHei UI", sans-serif';
    ctx.fillText('放入 assets/ 即可', cx, cy + 9);
    ctx.restore();

    spriteState.placeholder = true;
    spriteState.drewFrames++;
  }

  function drawSpriteFrame(group, idx) {
    const g = spriteGroups[group];
    if (!g || !g.images[idx] || !ctx) return false;
    const img = g.images[idx];
    if (!img.complete || !img.naturalWidth) return false;
    const scale = Math.min(CW / img.naturalWidth, CH / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    ctx.clearRect(0, 0, CW, CH);
    ctx.drawImage(img, (CW - w) / 2, (CH - h) / 2, w, h);
    spriteState.available = true;
    spriteState.placeholder = false;
    spriteState.activeGroup = group;
    spriteState.activeFrame = idx;
    spriteState.drewFrames++;
    return true;
  }

  let lastAdvance = 0;
  // 切到某个动作。onEnd 决定"播完之后去哪"，默认回待机。
  function playGroup(name, { loop = true, force = false, onEnd = null } = {}) {
    const g = spriteGroups[name];
    if (!g || !g.images.length) return false;
    const curPrio = spriteTimeline.name ? (PRIORITY[spriteTimeline.name] ?? 5) : -1;
    const newPrio = PRIORITY[name] ?? 5;
    if (!force && spriteTimeline.name && newPrio < curPrio) {
      dlog('sprite-play', `忽略「${name}」(优先级 ${newPrio})，正在播「${spriteTimeline.name}」(优先级 ${curPrio})`);
      return false;
    }
    spriteTimeline.name = name;
    spriteTimeline.loop = loop;
    spriteTimeline.onEnd = onEnd;
    lastAdvance = performance.now();
    drawSpriteFrame(name, 0);
    dlog('sprite-play', `播放动作「${name}」loop=${loop} 优先级=${newPrio} 帧数=${g.images.length}`);
    return true;
  }

  // 回到待机；若鼠标还停在角色上，就停在"靠近"动作的最后一帧
  function backToIdle(reason) {
    if (spriteState.hovering && spriteGroups.hover) {
      const g = spriteGroups.hover;
      spriteTimeline.name = 'hover';
      spriteTimeline.loop = false;
      spriteTimeline.onEnd = null;
      drawSpriteFrame('hover', g.images.length - 1);
      dlog('sprite-play', `${reason} → 停在「hover」最后一帧（鼠标仍在角色上）`);
      return;
    }
    const base = spriteState.baseGroup;
    if (spriteGroups[base]) playGroup(base, { loop: true, force: true });
  }

  function playAction(primary, aliases = []) {
    for (const n of [primary, ...aliases]) {
      if (spriteGroups[n]) return playGroup(n, { loop: false, force: true, onEnd: () => backToIdle(`「${n}」播完`) });
    }
    return false;
  }

  function tick(ts) {
    if (!spriteState.available) {
      drawPlaceholder(ts); // 空位提示（呼吸式脉动）
      requestAnimationFrame(tick);
      return;
    }
    if (spriteTimeline.name) {
      const g = spriteGroups[spriteTimeline.name];
      if (g && ts - lastAdvance >= (g.delays[spriteState.activeFrame] || 120)) {
        lastAdvance = ts;
        const next = spriteState.activeFrame + 1;
        if (next >= g.images.length) {
          if (spriteTimeline.loop) {
            drawSpriteFrame(spriteTimeline.name, 0);
          } else {
            const cb = spriteTimeline.onEnd;
            spriteTimeline.name = null;
            spriteTimeline.onEnd = null;
            if (typeof cb === 'function') cb();
            else backToIdle('一次动作播完');
          }
        } else {
          drawSpriteFrame(spriteTimeline.name, next);
        }
      }
    }
    requestAnimationFrame(tick);
  }

  async function initSprite() {
    if (!ctx) { spriteState.reason = '页面里没有 #sprite 画布'; return; }
    let manifest = null;
    try {
      manifest = await window.pet.getAssetManifest();
    } catch (err) {
      spriteState.reason = '获取素材清单失败: ' + (err && err.message);
      dlog('sprite-init', spriteState.reason);
      return;
    }
    if (!manifest || !manifest.found || !manifest.ok) {
      spriteState.reason = (manifest && (manifest.reason || (manifest.problems || []).join('; '))) || '没有素材';
      dlog('sprite-init', `无素材，显示空位提示（${spriteState.reason}）`);
      return;
    }
    if (manifest.problems && manifest.problems.length) dlog('sprite-init', '素材告警: ' + manifest.problems.join('; '));

    for (const [name, g] of Object.entries(manifest.groups)) {
      const images = [], delays = [];
      await Promise.all(g.frames.map((f, i) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { images[i] = img; delays[i] = f.delayMs; resolve(true); };
        img.onerror = () => resolve(false);
        img.src = f.url;
      })));
      const loaded = images.filter((im) => im && im.naturalWidth).length;
      if (loaded !== g.frames.length) {
        dlog('sprite-load', `动作「${name}」仅 ${loaded}/${g.frames.length} 帧可用，跳过`);
        continue;
      }
      spriteGroups[name] = { images, delays };
    }

    const names = Object.keys(spriteGroups);
    if (!names.length) {
      spriteState.reason = '所有动作的帧都没能加载';
      dlog('sprite-init', spriteState.reason);
      return;
    }

    // ★ 按素材真实宽高比设定显示框（取所有帧里"最宽"的那一帧，保证谁也裁不到）
    let maxRatio = 0, maxW = 0, maxH = 0;
    for (const g of Object.values(spriteGroups)) {
      for (const im of g.images) {
        if (!im || !im.naturalWidth) continue;
        const r = im.naturalWidth / im.naturalHeight;
        if (r > maxRatio) { maxRatio = r; maxW = im.naturalWidth; maxH = im.naturalHeight; }
      }
    }
    if (maxRatio > 0) {
      CW = Math.max(60, Math.min(DISP_W_MAX, Math.round(DISP_H * maxRatio)));
      CH = DISP_H;
      if (canvas) { canvas.width = CW; canvas.height = CH; }
      const cssW = CW + 'px', cssH = CH + 'px';
      canvas.style.width = cssW; canvas.style.height = cssH;
      pet.style.setProperty('--sprite-w', cssW);
      pet.style.setProperty('--sprite-h', cssH);
      spriteState.display = { w: CW, h: CH, ratio: +maxRatio.toFixed(3) };
      try { window.pet.setContentRatio(maxRatio); } catch { /* 忽略 */ }
      dlog('sprite-init', `显示框按素材比例设为 ${CW}x${CH}（最大帧 ${maxW}x${maxH}，比例 ${maxRatio.toFixed(3)}）`);
    }
    const primary = spriteGroups.idle ? 'idle' : names[0];
    spriteState.groups = names;
    spriteState.baseGroup = primary;
    spriteState.reason = '已启用';
    spriteState.placeholder = false;
    playGroup(primary, { loop: true, force: true });
    dlog('sprite-init', `帧动画已启用：动作=[${names.join(', ')}]，待机=${primary}`);
    console.log(`[桌宠] 帧动画已启用：${names.join(' / ')}（待机 ${primary}）`);

    // 形象变了必须重算穿透掩码（否则点击判定范围跟角色对不上）
    setTimeout(() => {
      try {
        window.pet.refreshMask();
        dlog('sprite-init', '已请求重算穿透掩码');
      } catch (err) {
        dlog('sprite-init', '请求重算掩码失败: ' + (err && err.message));
      }
    }, 350);
  }

  requestAnimationFrame(tick);
  initSprite();

  // ---------- 自检入口 ----------
  let clickCount = 0;
  pet.addEventListener('click', () => { clickCount++; });
  const rightDiag = { mousedown: 0, mouseup: 0, contextmenu: 0, lastAt: null, lastTarget: null };
  window.addEventListener('mousedown', (e) => {
    if (e.button === 2) { rightDiag.mousedown++; rightDiag.lastAt = Date.now(); rightDiag.lastTarget = e.target?.tagName; }
  }, true);
  window.addEventListener('mouseup', (e) => { if (e.button === 2) rightDiag.mouseup++; }, true);
  window.addEventListener('contextmenu', () => { rightDiag.contextmenu++; }, true);

  // 面板状态快照（自检用）
  function memoSnapshot() {
    const rows = memoList ? memoList.querySelectorAll('.memo-item') : [];
    const emptyRows = memoList ? memoList.querySelectorAll('.memo-item.empty') : [];
    const boxes = memoList ? memoList.querySelectorAll('.memo-box') : [];
    return {
      open: memoState.open,
      cap: MEMO_VISIBLE,           // 默认可见栏数（不再是硬上限）
      visible: MEMO_VISIBLE,
      count: memoState.tasks.length,
      tasks: memoState.tasks.map((t) => t.text),
      renderedRows: rows.length,
      emptyRows: emptyRows.length,
      boxCount: boxes.length,
      // 滚动状态
      scrollable: !!memoState.scrollable,
      scrollHeight: memoScroll ? memoScroll.scrollHeight : 0,
      clientHeight: memoScroll ? memoScroll.clientHeight : 0,
      scrollTop: memoScroll ? Math.round(memoScroll.scrollTop) : 0,
      maxScroll: memoScroll ? Math.max(0, memoScroll.scrollHeight - memoScroll.clientHeight) : 0,
      // 输入框是否真的能被键盘输入
      inputFocused: !!(memoInput && document.activeElement === memoInput),
      inputValue: memoInput ? memoInput.value : null,
      foot: memoFoot ? memoFoot.textContent : '',
      panelVisible: !!(memoEl && memoEl.classList.contains('show')),
      panelRect: memoEl ? (() => { const r = memoEl.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      panelInViewport: memoEl ? (() => { const r = memoEl.getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })() : null,
      addedTotal: memoState.added,
      removedTotal: memoState.removed,
      renders: memoState.renders,
      opens: memoState.opens,
      closes: memoState.closes,
    };
  }

  window.__petTest = {
    click: () => pet.click(),
    action: (n) => {
      if (n === 'headpat') { say(pick(LINES.pat)); playAnim('pat', 720); }
      if (n === 'angry') { say(pick(LINES.angry)); playAnim('angry', 1300); }
    },
    probeHit: (x, y) => {
      const el = document.elementFromPoint(x, y);
      const hit = !!(el && pet.contains(el));
      lastHit = hit;
      window.pet.pointerHit(hit);
      return { hit, element: describeTarget(el) };
    },
    keyboardMenu: (fromInput) => {
      // 默认从 window 派发（模拟"面板没开时按键"）；
      // fromInput=true 时从输入框派发，走真实的冒泡路径（输入框会 stopPropagation 接管键盘）
      const target = fromInput && memoInput ? memoInput : window;
      const before = window.__petContextMenuCount || 0;
      const ev = new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, bubbles: true, cancelable: true });
      target.dispatchEvent(ev);
      const after = window.__petContextMenuCount || 0;
      return {
        count: after,
        delta: after - before,               // 本次按键是否真的触发了菜单（0 = 被输入框吞掉）
        from: window.__petContextMenuFrom || null,
        dispatchedOn: fromInput ? 'memoInput' : 'window',
        defaultPrevented: ev.defaultPrevented,
      };
    },
    realClick: () => {
      const r = pet.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const sx = Math.round(window.screenX + x), sy = Math.round(window.screenY + y);
      const base = { bubbles: true, cancelable: true, clientX: x, clientY: y, screenX: sx, screenY: sy, button: 0, detail: 1 };
      const before = { say: sayCount, click: clickCount };
      pet.dispatchEvent(new MouseEvent('mousedown', base));
      window.dispatchEvent(new MouseEvent('mouseup', base));
      pet.dispatchEvent(new MouseEvent('click', base));
      return { sayDelta: sayCount - before.say, clickDelta: clickCount - before.click, dragging };
    },
    realClickWithJitter: (jitterPx) => {
      const r = pet.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const j = jitterPx || 0;
      const base = { bubbles: true, cancelable: true, button: 0, detail: 1 };
      const before = { say: sayCount, click: clickCount };
      pet.dispatchEvent(new MouseEvent('mousedown', { ...base, clientX: x, clientY: y, screenX: window.screenX + x, screenY: window.screenY + y }));
      window.dispatchEvent(new MouseEvent('mouseup', { ...base, clientX: x + j, clientY: y + j, screenX: window.screenX + x + j, screenY: window.screenY + y + j }));
      pet.dispatchEvent(new MouseEvent('click', { ...base, clientX: x + j, clientY: y + j, screenX: window.screenX + x + j, screenY: window.screenY + y + j }));
      return { sayDelta: sayCount - before.say, clickDelta: clickCount - before.click, jitter: j };
    },
    realDrag: async (movePx) => {
      const r = pet.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const base = { bubbles: true, cancelable: true, button: 0, detail: 1 };
      const sx = Math.round(window.screenX + x), sy = Math.round(window.screenY + y);
      const m = movePx || 30;
      pet.dispatchEvent(new MouseEvent('mousedown', { ...base, clientX: x, clientY: y, screenX: sx, screenY: sy }));
      window.dispatchEvent(new MouseEvent('mousemove', { ...base, clientX: x + m, clientY: y + m, screenX: sx + m, screenY: sy + m }));
      await new Promise((res) => setTimeout(res, 120));
      const draggingDuring = dragging;
      window.dispatchEvent(new MouseEvent('mouseup', { ...base, clientX: x + m, clientY: y + m, screenX: sx + m, screenY: sy + m }));
      return { draggingDuring, draggingAfter: dragging };
    },
    realContextMenu: () => {
      const before = window.__petContextMenuCount || 0;
      const r = pet.getBoundingClientRect();
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
      const ret = pet.dispatchEvent(ev);
      return { fired: (window.__petContextMenuCount || 0) > before, count: window.__petContextMenuCount || 0,
        from: window.__petContextMenuFrom || null, defaultPrevented: ev.defaultPrevented, dispatchReturn: ret };
    },
    dragSimulate: async () => {
      const bounds = await window.pet.getBounds();
      window.pet.dragStart({
        cursorX: bounds.x + Math.round(bounds.width / 2),
        cursorY: bounds.y + Math.round(bounds.height / 2),
        winX: bounds.x, winY: bounds.y, winW: 200, winH: 250, dryRun: true,
      });
      await new Promise((r) => setTimeout(r, 120));
      window.pet.dragEnd();
      return { bounds, ok: true };
    },
    // 待办面板测试入口
    memoOpen: () => { openMemo(); return memoSnapshot(); },
    memoClose: () => { closeMemo(); return memoSnapshot(); },
    memoToggle: () => { toggleMemo(); return memoSnapshot(); },
    memoAdd: (text) => ({ ...memoSnapshot(), added: addTask(text) }),
    memoComplete: (index) => ({ ...memoSnapshot(), started: completeTask(index) }),
    // 同步删除（自检用）：真实 completeTask 有 220ms 删除线反馈动画，
    // 测试里连续调用会互相打架（任务在中途就被删空），所以留一条同步通道。
    memoCompleteNow: (index) => {
      const t = memoState.tasks[index];
      if (!t) return { ...memoSnapshot(), started: false };
      memoState.tasks.splice(index, 1);
      memoState.removed++;
      saveTasks();
      renderMemo();
      return { ...memoSnapshot(), started: true };
    },
    memoClear: () => { memoState.tasks = []; saveTasks(); renderMemo(); return memoSnapshot(); },
    memoSnapshot,
    memoScrollTo: (top) => {
      if (memoScroll) { memoScroll.scrollTop = top; }
      return memoSnapshot();
    },
    state: () => ({
      petClasses: pet.className,
      bubbleShown: bubble.classList.contains('show'),
      bubbleText: bubble.textContent,
      bubbleOpacity: +(getComputedStyle(bubble).opacity),
      bubbleVisibility: getComputedStyle(bubble).visibility,
      bubbleRect: (() => { const r = bubble.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      bubbleInViewport: (() => { const r = bubble.getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })(),
      lastHit, clickCount, sayCount, dragging,
      contextMenuCount: window.__petContextMenuCount || 0,
      rightDiag: { ...rightDiag },
      scopeClass: pet.className,
      sprite: {
        available: spriteState.available,
        placeholder: spriteState.placeholder,
        reason: spriteState.reason,
        groups: spriteState.groups,
        baseGroup: spriteState.baseGroup,
        activeGroup: spriteState.activeGroup,
        activeFrame: spriteState.activeFrame,
        drewFrames: spriteState.drewFrames,
        canvasSize: CW + 'x' + CH,
        display: spriteState.display || null,
        timeline: spriteTimeline.name ? { group: spriteTimeline.name, loop: spriteTimeline.loop } : null,
        hovering: spriteState.hovering,
        hoverEnters: hoverState.enters,
        hoverExits: hoverState.exits,
      },
    }),
  };

  dlog('startup', `渲染层就绪（通用机制版）：视口=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} 画布=${CW}x${CH}`);
  console.log('[桌宠] 渲染层就绪（无内置主题形象，等待素材）');
})();
