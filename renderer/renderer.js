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

  // ---------- 台词（中性，与主题无关） ----------
  // ⚠️ 第 32 轮起这里是**离线兜底**，不再是唯一来源：
  //   接上 API 时「开心开 / 开心关 / 生气 / 空闲开口」这四种台词由主进程决定（可能来自大模型），
  //   渲染层调 `window.pet.actionLine({action})` 拿结果。摸头**永远是本地这几句**（主人明确要求）。
  //   真值表在 lib/action-lines.js —— 那里是权威，这里这份只是它的一份投影（保持一致，别手改）。
  const LINES = {
    click: ['戳人家干嘛啦。', '在的在的。', '人家醒着呢。', '今日状态：还行。'],
    pat: ['唔……别摸啦。', '就、就一下哦。', '（眯眼）'],
    angry: ['哼！不理你了。', '再说人家就罢工了！', '（鼓起来）'],
    happy: ['嘿嘿～今天也很开心！', '人家心情超好！', '（尾巴摇摇）'],
    happyOff: ['好啦，人家不闹了～', '（恢复平时的样子）'],
    idle: ['（人家在这儿哦）', '主人在忙吗？', '白饭……想吃白饭……', '（尾巴轻轻晃了晃）'],
  };
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- 台词来源（第 32 轮） ----------
  // 「等模型说完再开口」（主人 2026-10-02 定的）：动画**立刻**播，台词等主进程那一趟回来再显示。
  //   - 没配 API / 关掉对话 / 对应时机没开 → 主进程立刻回本地台词，主人感觉不到延迟；
  //   - 真的走模型 → 会有 1～3 秒静默，这段时间她只做动作不出声（这就是主人要的"等模型说完再开口"）。
  // 迟到保护：连点两下「开心」时，第一趟的回复回来不许再说话（否则先"开心"后"收起"会串台）。
  let lineReqSeq = 0;
  function localLine(action) {
    const arr = LINES[action] || LINES.click;
    return pick(arr);
  }
  async function requestLine(action, why) {
    const seq = ++lineReqSeq;
    try {
      const res = await window.pet.actionLine({ action });
      if (seq !== lineReqSeq) {
        dlog('line', `台词迟到了，丢弃（${action}：第 ${seq} 趟，最新是第 ${lineReqSeq} 趟）`);
        return null;
      }
      const text = (res && res.text) || localLine(action);
      say(text);
      dlog('line', `台词(${action}) 来源=${res && res.source} 原因=${res && res.reason}${res && res.ms ? ` ${res.ms}ms` : ''}：${text}`);
      return text;
    } catch (err) {
      // 主进程那条路整个挂了也不能哑巴：退回本地那句（气泡里永远不出现技术错误）
      if (seq === lineReqSeq) { say(localLine(action)); dlog('line', `actionLine 抛错，退回本地台词：${err && err.message}`); }
      return null;
    }
  }


  // ---------- 气泡 ----------
  let bubbleTimer = null;
  let sayCount = 0;
  let lastSay = '';      // 最近一次真的显示出来的台词（自检断言"说对了没有"用，比读气泡更直接）
  let lastSayAt = 0;
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
  function say(text, ms) {
    sayCount++;
    lastSay = String(text == null ? '' : text);
    lastSayAt = Date.now();
    bubble.textContent = text;
    bubble.classList.add('show');
    chirp();
    clearTimeout(bubbleTimer);
    // 主人要求气泡能放长句 → 字数越多停得越久（60 字 ≈ 7.4 秒，够读完）。
    // 调用方明确给了时长就以调用方为准（主进程按"成功/失败"给的 5.2s / 4.2s），
    // 但**绝不允许比自动时长还短** —— 长回复一闪而过就等于没有。
    const auto = Math.min(12000, Math.max(2600, 2600 + Math.max(0, String(text).length - 16) * 110));
    const hold = Number.isFinite(ms) && ms > 0 ? Math.max(ms, auto) : auto;
    bubbleTimer = setTimeout(() => bubble.classList.remove('show'), hold);
    // 气泡变宽了 → 重新算"躲开面板"的偏移（scale 过渡结束后再算一次，取的是最终尺寸）
    relayoutBubble();
    setTimeout(relayoutBubble, 180);
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
  const MEMO_VISIBLE = 4;   // 默认可见栏数（2 列 × 2 行 = 4 格；第 25 轮从 5 改成 4 给"和她说…"腾高度）
  const MEMO_KEY = 'desktopPet.memo.tasks';
  const memoEl = document.getElementById('memo');
  const memoList = document.getElementById('memoList');
  const memoScroll = document.getElementById('memoScroll');
  const memoInput = document.getElementById('memoInput');
  const memoCountEl = document.getElementById('memoCount');
  const memoCapEl = document.getElementById('memoCap');
  const memoFoot = document.getElementById('memoFoot');
  const chatInput = document.getElementById('chatInput');
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

  // ---------- 气泡要躲开提问面板（主人 2026-09-24：「回复与提问窗口总在同一侧」） ----------
  // 问题：面板展开时窗口是 [面板列][桌宠列]，气泡却一直居中在**整个窗口**里 →
  //       它骑在"面板列和桌宠列的接缝"上，看起来就是"回复压在提问窗口上"。
  // 修法（第 26 轮定稿）：**给气泡专门留一列**（主进程的 BUBBLE_COL），
  //       窗口 = [气泡列][面板列][桌宠列]（面板在右时）。气泡落在气泡列中间，
  //       与面板之间天然隔着一整列的距离，怎么都不会压上；而且**收起态也保留这一列**，
  //       所以同一句话在开/关面板时都出现在屏幕上的同一个位置，不会左右跳。
  //       气泡的落位由 CSS 的 .scene.chatting .bubble 直接定在气泡列里（不再算偏移）。
  let chatting = false;

  // 气泡的落点（主人 2026-09-27 定的规矩）：
  //   · 面板收起 → 气泡在**她的左上方**（贴着她左上角）
  //   · 面板打开 → 面板钉在窗口左边，气泡**改到她右上方**（面板的另一侧），还是紧挨着她
  // 为什么用 JS 量矩形、不用纯 CSS：她/面板都是绝对定位，用 CSS 变量算坐标一旦有一处不同步
  // （实测差 37px）气泡就会被推到窗口外。量真实矩形最稳。
  const BUBBLE_GAP = 8;          // 气泡与她之间的空隙
  const BUBBLE_MIN_LEFT = 8;     // 气泡左边界至少离窗口左边 8px
  function relayoutBubble() {
    if (!bubble || !pet) return 0;
    let left = BUBBLE_MIN_LEFT;
    // 纵向：钉在她头顶上方（她的上边界往上再留一点），并**夹在窗口内**
    // （素材换一帧、她往上冒一点时，气泡不许跟着跑出窗口 —— 实测被推到 -75px）
    let top = 4;
    try {
      const cs = getComputedStyle(bubble);
      const bw = bubble.offsetWidth || 150;
      const bh = bubble.offsetHeight || 60;
      const petEl = document.getElementById('sprite') || pet;
      const pr = petEl.getBoundingClientRect();
      // 横轴
      if (memoState.open) {
        // 面板在左 → 气泡在她**右边**（贴着她右边界 + 8；再夹进窗口）
        const want = Math.round(pr.right + BUBBLE_GAP);
        left = Math.min(Math.max(want, BUBBLE_MIN_LEFT), Math.max(BUBBLE_MIN_LEFT, Math.round(window.innerWidth - bw - 8)));
      } else {
        // 面板收起 → 气泡在她**左上方**（右边界 = 她左边界 - 8）
        const want = Math.round(pr.left - BUBBLE_GAP - bw);
        left = Math.max(BUBBLE_MIN_LEFT, Math.min(want, Math.round(window.innerWidth - bw - 8)));
      }
      // 纵轴：**贴在她头顶上方**（横向与她的头齐平、纵向不压到她），整块气泡夹在窗口内
      top = Math.max(2, Math.min(Math.round(pr.top) - bh - 6, Math.round(window.innerHeight - bh - 4)));
    } catch { /* 量不到就用最小值 */ }
    bubble.style.left = left + 'px';
    bubble.style.right = 'auto';
    bubble.style.top = top + 'px';
    bubble.style.bottom = 'auto';
    return left;
  }

  // 主进程算完"面板放哪边"会回传。⚠️ 命名坑过一次，这里写清楚：
  //   side='right' = 面板在**右侧**（气泡列在更左、桌宠仍在最右）→ 这是**默认布局**，
  //                  所以**不加** panel-right 类（CSS 里 .scene 的默认列序就是它）。
  //   side='left'  = 面板放左侧（窗口左边放不下时才会走）→ 加 panel-right：桌宠换到最左列、气泡列挪到最右。
  //   第 26 轮第一版把这两个搞反了，结果"打开面板时桌宠被推到左边 341px"，自检当场抓到。
  window.pet.onPanelSide((side) => {
    panelSide = side || null;
    sceneEl.classList.toggle('panel-right', side === 'left');
    placePanel();          // 面板固定钉在窗口左边（气泡改到她右边躲开它）
    relayoutBubble();      // 气泡跟着她的新位置重算
    dlog('memo', `面板布局：面板固定钉在窗口左边，气泡在她右边（她屏幕位置不变）`);
  });

  // 面板的落点：**紧贴她的左边**（主人 2026-09-27 反馈："面板飞到左边去了，紧贴人物左边不重合就行"）。
  // 为什么由 JS 按她的真实矩形算：窗口宽 = 面板 + 人物 + 气泡，面板左边界 = 她左边界 - 面板宽 - 间隙，
  // 这样面板永远贴着她（不管窗口多宽、素材多宽），而且**绝不与她重叠**。
  const PANEL_W = 300;      // 面板 288 + 左右各 6 边距（和 CSS 一致）
  const PANEL_GAP = 2;      // 面板与人物之间的空隙（只留一点点，视觉上就是"紧贴"）
  function placePanel() {
    if (!memoEl || !pet) return;
    let left = 6;
    try {
      const pr = pet.getBoundingClientRect();
      left = Math.max(6, Math.round(pr.left - PANEL_W - PANEL_GAP));
    } catch { /* 量不到就贴最左 */ }
    memoEl.style.left = left + 'px';
    memoEl.style.right = 'auto';
  }

  function openMemo() {
    if (memoState.open) return false;
    memoState.open = true;
    memoState.opens++;
    if (memoEl) { memoEl.classList.add('show'); memoEl.setAttribute('aria-hidden', 'false'); }
    sceneEl.classList.add('memo-open');
    placePanel();                      // 面板钉在窗口左边
    renderMemo();
    requestPanelSize(true);
    // 面板一出现就切到"对话布局"（气泡到她右边、躲开面板）
    chatting = true;
    sceneEl.classList.add('chatting');
    setTimeout(() => { placePanel(); relayoutBubble(); }, 60);   // 窗口变宽后再校正一次
    relayoutBubble();
    // 让键盘焦点落到输入框（面板要能打字），同时把窗口提到可交互层
    try { window.pet.focusWindow(); } catch { /* 忽略 */ }
    setTimeout(() => { if (memoInput) memoInput.focus(); }, 120);
    dlog('memo', `面板展开，当前 ${memoState.tasks.length} 条（默认可见 ${MEMO_VISIBLE} 栏，超出滚动）；气泡已躲到面板另一侧`);
    return true;
  }

  function closeMemo() {
    if (!memoState.open) return false;
    memoState.open = false;
    memoState.closes++;
    if (memoEl) { memoEl.classList.remove('show'); memoEl.setAttribute('aria-hidden', 'true'); }
    sceneEl.classList.remove('memo-open');
    if (memoInput) memoInput.value = '';
    // 面板没了 → 气泡回中间（保持"收起态和以前一模一样"）
    chatting = false;
    sceneEl.classList.remove('chatting');
    relayoutBubble();
    requestPanelSize(false);
    dlog('memo', '面板收起（气泡恢复居中）');
    return true;
  }

  function toggleMemo() {
    // 开面板 = 主人理她了：通知主进程把"空闲计时"归零（第 32 轮）。
    // 不做的话，面板开着的时候她可能自己冒出来"主动搭话"，跟主人正在输入框打字撞在一起。
    try { window.pet.userActive('memo-toggle'); } catch { /* 通知失败不影响面板 */ }
    return memoState.open ? closeMemo() : openMemo();
  }

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
  loadTasks();
  renderMemo();

  // ---------- 和她说话（第 25 轮：接 API） ----------
  // 分工：渲染层只负责"把主人输入的那句话交给主进程 + 把回复显示出来"；
  //       密钥、请求、上下文全在主进程（渲染层带着 CSP default-src 'none'，本来就发不出请求）。
  const chatState = { sending: false, sends: 0, replies: 0, errors: 0, lastText: '', lastKind: null, lastMs: 0 };
  const CHAT_PLACEHOLDER = '跟我说句话吧，回车发送…';
  const CHAT_BUSY_PLACEHOLDER = '人家正在想…（回车取消不了，稍等一下）';

  function setChatBusy(on) {
    chatState.sending = !!on;
    if (!chatInput) return;
    chatInput.disabled = !!on;
    chatInput.placeholder = on ? CHAT_BUSY_PLACEHOLDER : CHAT_PLACEHOLDER;
    chatInput.classList.toggle('busy', !!on);
  }

  async function sendChatLine(text) {
    const msg = String(text || '').trim();
    if (!msg) return { ok: false, kind: 'empty', text: '' };
    if (chatState.sending) return { ok: false, kind: 'busy', text: '' };
    chatState.sends++;
    setChatBusy(true);
    // 先让她有个反应：不然回车之后界面一动不动，主人会以为没生效
    say('…嗯？', 2600);
    dlog('chat', `发送：${msg.slice(0, 40)}`);
    try {
      const res = await window.pet.chatSend({ text: msg, source: 'input' });
      chatState.lastText = res && res.text ? res.text : '';
      chatState.lastKind = res ? res.kind : 'unknown';
      chatState.lastMs = res ? res.ms : 0;
      if (res && res.ok) chatState.replies++; else chatState.errors++;
      // 台词由主进程给（成功给回复，失败给"钥匙不对/连不上"那句），这里原样显示
      if (res && res.text) say(res.text, res.ok ? 5200 : 4200);
      dlog('chat', `回复 kind=${chatState.lastKind} ${chatState.lastMs}ms：${(chatState.lastText || '').slice(0, 40)}`);
      return res;
    } catch (err) {
      chatState.errors++;
      chatState.lastKind = 'ipc';
      say('（人家这边出了点小问题…）', 4200);
      dlog('chat', '发送失败: ' + (err && err.message));
      return { ok: false, kind: 'ipc', text: '（人家这边出了点小问题…）' };
    } finally {
      setChatBusy(false);
      if (chatInput && memoState.open) { try { chatInput.focus(); } catch { /* 忽略 */ } }
    }
  }

  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();  // 键盘归输入框，不许冒泡去触发全局快捷键（Ctrl+M 等）
      if (e.key === 'Enter') {
        const text = chatInput.value;
        chatInput.value = '';
        sendChatLine(text);
      } else if (e.key === 'Escape') {
        // 正在等回复时不收面板：回复是异步回来的，面板关了气泡也跟着没了
        if (!chatState.sending) closeMemo();
      }
    });
  }

  // ---------- 关闭面板的三种方式（主人要求：去掉 × 号，点区域外自动关闭） ----------
  // 1) mousedown 落在面板与角色之外（同一窗口内的空白区）→ 关闭
  // 2) 点角色本身 → 由 pet 的 click 处理器 toggle（这里不重复处理，避免打架）
  // 3) 点窗口外面的桌面：透明窗口把鼠标事件穿透出去了，渲染层**收不到任何事件**，
  //    所以这条必须靠主进程轮询鼠标位置来兜底（见 pet:pointer-outside）
  document.addEventListener('mousedown', (e) => {
    if (!memoState.open) return;
    const t = e.target;
    if (memoEl && memoEl.contains(t)) return;   // 点面板内部 → 不关
    if (pet.contains(t)) return;                 // 点角色 → 交给 click 处理器 toggle
    dlog('memo', `点击面板外（${describeTarget(t)}）→ 收起面板`);
    closeMemo();
  }, true);

  // 主进程发现鼠标已移出整个窗口 → 通知收起（穿透态下渲染层收不到事件，只能这样兜）
  window.pet.onPointerOutside(() => {
    if (!memoState.open) return;
    dlog('memo', '鼠标已离开窗口（穿透态）→ 收起面板');
    closeMemo();
  });

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
    clearHoverTimer();
    hoverArmed = false;
    if (hoverState.active) setHover(false);
  });

  // ---------- 鼠标靠近 ----------
  // 主人明确说"点击功能已经被占用"（左键=待办面板），所以"靠近"用**鼠标移入角色**触发。
  // ★ 主人 2026-09-27 追加的规矩：**必须悬停 0.5 秒才播触碰动画**（鼠标一扫而过不打扰她）。
  //   · 移入/停在她身上 → 起 500ms 定时器，到点还停着才真的切「靠近」
  //   · 移出 → **立刻**取消定时器 + 立刻回待机（走了就是走了）
  //   判定用逐像素（pointOnCharacter）：矩形四角都是空气，不能算"在她身上"。
  const HOVER_DELAY_MS = 300;   // 主人 2026-09-27：悬停 0.3 秒就播触碰动画
  let hoverArmed = false;       // 500ms 已到（这一轮已经播过「靠近」）
  let hoverTimer = null;        // 等待中的悬停定时器
  function clearHoverTimer() {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  }
  function setHover(on) {
    if (on === hoverState.active) return;
    hoverState.active = on;
    spriteState.hovering = on;
    if (on) hoverState.enters++; else hoverState.exits++;
    if (!spriteState.available) { dlog('hover', `靠近=${on}（无素材，忽略）`); return; }
    // 保持动作期间，"靠近/离开"都不许改动作 —— 主人要的是"一直保持住"，
    // 鼠标从她身上划过就把姿势顶掉的话，这个功能就等于没有。
    if (poseHold.group && spriteGroups[poseHold.group]) {
      dlog('hover', `靠近=${on} → 保持动作「${poseHold.group}」中，不切「靠近/待机」`);
      return;
    }
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

  // 鼠标停在她身上：只有**连续停够 500ms** 才触发（中间移开就作废，一切从零开始）
  function scheduleHover() {
    if (hoverArmed) return;                    // 这一轮已经触发过了（一直停着，不重复播）
    if (hoverTimer) return;                    // 已经在倒计时
    hoverTimer = setTimeout(() => {
      hoverTimer = null;
      hoverArmed = true;
      hoverState.delays++;
      dlog('hover', `悬停满 ${HOVER_DELAY_MS}ms → 播「靠近」动作`);
      setHover(true);
    }, HOVER_DELAY_MS);
  }

  // 鼠标离开她身上：立刻取消等待、立刻回待机
  function cancelHover(why) {
    const hadTimer = !!hoverTimer;
    clearHoverTimer();
    if (!hoverArmed && !hadTimer) return;
    hoverArmed = false;
    if (hadTimer) {
      hoverState.cancels++;
      dlog('hover', `还没悬停满 ${HOVER_DELAY_MS}ms 就离开了（${why}）→ 不播「靠近」`);
    }
    setHover(false);
  }

  // ---------- 「鼠标是不是真的在她身上」（逐像素，第 27 轮加的） ----------
  // 为什么不能用"矩形判定"：角色矩形是 167×200 的**整块**，四个角都是空气。
  //   主人 2026-09-25 的反馈（"往下移开不恢复待机"）根因就在这儿：
  //   鼠标从她身上往**下**滑，只要还在那块矩形里，渲染层就一直认为"还在她身上"
  //   → 动作永远停在「靠近」的最后一帧（而往左/往上滑很快就出矩形，所以看着像"只有下/右有问题"）。
  // 现在改成读画布的 alpha：位置映射到帧图上是透明的 = 不在她身上。
  // 性能：逐帧缓存成一张 Uint8 位图（只在帧第一次出现时算一次），mousemove 里查表即可。
  const alphaCache = new Map();      // 'group#idx' → {w,h,data,painted}
  function alphaMapOf(group, idx) {
    const key = group + '#' + idx;
    const hit = alphaCache.get(key);
    if (hit) return hit;
    if (!canvas || !ctx || !CW || !CH) return null;
    let img = null;
    try { img = ctx.getImageData(0, 0, CW, CH); } catch { return null; }   // 跨域污染的画布会抛
    const data = new Uint8Array(CW * CH);
    let painted = 0;
    for (let i = 0, p = 3; i < data.length; i++, p += 4) {
      if (img.data[p] > 24) { data[i] = 1; painted++; }
    }
    const rec = { w: CW, h: CH, data, painted };
    alphaCache.set(key, rec);
    if (alphaCache.size > 24) alphaCache.delete(alphaCache.keys().next().value);   // 别无限涨
    return rec;
  }
  // 判断"这个点是不是落在角色身上"。rect 里先粗筛（省掉大部分计算），命中再查逐像素位图。
  function pointOnCharacter(clientX, clientY) {
    const r = pet.getBoundingClientRect();
    if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return false;
    const tl = spriteTimeline.name || spriteState.baseGroup;
    const rec = tl ? alphaMapOf(tl, spriteState.activeFrame | 0) : null;
    if (!rec || !rec.painted) return true;              // 拿不到位图就退回矩形判定（老行为，不会更差）
    // 画布的 CSS 尺寸可能和位图尺寸不同（DPR/CW 取整），按比例映射
    const cw = canvas.clientWidth || rec.w;
    const ch = canvas.clientHeight || rec.h;
    const fx = Math.round((clientX - r.left) / (cw || 1) * rec.w);
    const fy = Math.round((clientY - r.top) / (ch || 1) * rec.h);
    if (fx < 0 || fy < 0 || fx >= rec.w || fy >= rec.h) return false;
    return rec.data[fy * rec.w + fx] === 1;
  }

  window.addEventListener('mousemove', (e) => {
    if (!spriteState.available) return;
    if (pointOnCharacter(e.clientX, e.clientY)) scheduleHover();
    else cancelHover('鼠标移动到角色外');
  });

  // ---------- 「靠近 → 离开」的兜底心跳（主人 2026-09-25 反馈的 bug） ----------
  // 现象：鼠标移进她身上会出现「靠近」姿势，但**往下 / 往右移开时不恢复待机**，一直定在那。
  // 根因：鼠标一离开角色矩形，穿透上报就把窗口切回"穿透态"（setIgnoreMouseEvents(true, forward)），
  //       而穿透态的窗口**不一定还收得到 mousemove** → 上面那个 setHover(false) 永远等不到
  //       → 时间线停在「靠近」的最后一帧（backToIdle 里那条"鼠标仍在角色上就不动"的分支）。
  // 修法：不去赌事件，**每 250ms 主动问一次主进程"鼠标现在在哪"**，
  //       只要发现鼠标已经不在角色矩形里，就强制复原（并补一次穿透上报，免得状态机两边不一致）。
  // ★ 自检时**默认关掉**它：自检用合成事件（真的鼠标可能在屏幕别处），
  //   兜底心跳会把"刚被合成事件设成 hover"的状态立刻改回待机，反而把断言搅黄。
  //   需要验它的那条回归断言会临时打开（见 __petTest.setHoverWatchdog）。
  let hoverWatchdogTicks = 0;
  let hoverWatchdogFixes = 0;
  let hoverWatchdogOn = false;
  setInterval(async () => {
    if (!hoverWatchdogOn) return;
    if (!spriteState.available || !spriteState.hovering) return;
    if (poseHold.group) return;              // 保持动作期间本来就不该被改
    hoverWatchdogTicks++;
    let cur = null;
    try { cur = await window.pet.getCursor(); } catch { return; }
    if (!cur || cur.screenX == null) return;
    // 坐标口径：平时 cur 是屏幕坐标（要减去窗口左上角）；自检的假鼠标直接给"窗口内坐标"
    const x = cur.relative ? cur.screenX : cur.screenX - cur.winX;
    const y = cur.relative ? cur.screenY : cur.screenY - cur.winY;
    // ★ 用**逐像素**判定（不是矩形）：鼠标还在矩形里、但已经滑到角色旁边的空气上，
    //   也算"离开了" —— 这正是主人反馈的"往下/往右移开不恢复待机"的修法。
    const inside = pointOnCharacter(x, y);
    if (inside) return;
    hoverWatchdogFixes++;
    dlog('hover', `兜底：鼠标 (${Math.round(x)},${Math.round(y)}) 已不在她身上（逐像素判定）→ 强制复原待机`);
    if (lastHit !== false) { lastHit = false; window.pet.pointerHit(false); }
    clearHoverTimer();                   // 连着"等待中的悬停"一起取消（还没满 500ms 就别播了）
    hoverArmed = false;
    setHover(false);
  }, 250);

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

  // ---------- 菜单动作 ----------
  // 主人把 1/5/6 分给"交互"，所以摸头等动作应当**播放交互动作组**（而不是只做轻微形变）。
  // 之前只做了 CSS 形变兜底，照片素材上几乎看不出来 → 主人反馈"摸头功能没有实现"。
  window.pet.onAction((name) => {
    dlog('action', `收到菜单动作「${name}」`);
    const INTERACT_GROUP = 'interact';
    if (name === 'headpat') {
      say(pick(LINES.pat));
      // 优先播"交互"动作组；组名也兼容 pet / headpat / pat
      const played = playAction(INTERACT_GROUP, ['pet', 'headpat', 'pat']);
      if (!played) { playAnim('pat', 720); dlog('action', '无交互素材 → 退回 CSS 形变动画'); }
      else dlog('action', `已播放「${INTERACT_GROUP}」交互动作组`);
      return;
    }
    if (name === 'happy') {
      // 「开心」是**开关**（主人 2026-09-24 的要求）：
      //   点一次 → 保持住这个动作（不自动收尾，人一直乐呵呵地站在那儿）
      //   再点一次 → 退出保持，回待机
      // 素材是主人给的专属 happy 组（目前一张定格图）；没有该组时才退回交互组/CSS 蹦跳。
      if (poseHold.group === 'happy') {
        poseHold.group = null;
        reportPose();
        requestLine('happyOff', '再点一次「开心」');   // 台词等模型（或本地兜底），动画不等
        dlog('action', '再点一次「开心」→ 退出保持动作，回待机');
        backToIdle('主人又点了一次「开心」');
        return;
      }
      requestLine('happy', '点上「开心」');             // 同上：先动起来，话随后到
      const g = spriteGroups.happy;
      if (g) {
        // loop=true 就是"保持"：单帧素材循环 = 定格住，多帧素材循环 = 一直播
        poseHold.group = 'happy';
        playGroup('happy', { loop: true, force: true });
        reportPose();
        // 单帧静止图叠一个 CSS 蹦跳，否则点下去就是一张完全不动的画，看不出反应
        if (g.images.length === 1) playAnim('hop', 520);
        dlog('action', `已进入「happy」保持动作（${g.images.length} 帧，loop 保持；再点一次菜单项才退出）`);
      } else if (playAction(INTERACT_GROUP, ['hop'])) {
        dlog('action', `没有 happy 素材 → 退回「${INTERACT_GROUP}」交互动作组（一次性，无保持）`);
      } else {
        playAnim('hop', 520);
        dlog('action', '既没有 happy 也没有交互素材 → 退回 CSS 蹦跳动画');
      }
      return;
    }
    if (name === 'angry') {
      requestLine('angry', '菜单点了「生气」');   // 同样等模型；没配 API 就是本地那句
      if (!playAction(INTERACT_GROUP, ['angry'])) playAnim('angry', 1300);
      else dlog('action', `已播放「${INTERACT_GROUP}」交互动作组`);
      return;
    }
  });

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
  // 「保持动作」（主人 2026-09-24 的要求）：
  //   「开心」点一次之后**不自动收尾**，就一直保持这个动作，直到主人再点一次同一个菜单项。
  //   实现 = 那一组用 loop 循环播（单帧素材就是"定格住"），并且把"回待机"和"鼠标靠近"两条
  //   自动切动作的路径都挡住 —— 否则鼠标一滑过去，她就被 hover 顶回普通样子了。
  //   存的是组名（现在只可能是 'happy'），为 null 表示没在保持。
  const poseHold = { group: null };
  // 把保持状态回报给主进程 → 右键菜单里那一项据此打勾（渲染层才是真状态）
  function reportPose() {
    try { window.pet.reportPose({ on: !!poseHold.group, group: poseHold.group }); } catch { /* 旧 preload 兼容 */ }
  }
  // 鼠标靠近状态（放在前面声明：mousemove 处理器在初始化阶段就可能调用 setHover，
  // 而 setHover 在下面才定义；用 const 声明在后面会踩 TDZ 的坑）
  const hoverState = { active: false, enters: 0, exits: 0, delays: 0, cancels: 0 };

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

  // ---------- 描边（sticker outline）----------
  // 主人 2026-09-24：**「参考左边那个桌宠，对我们桌宠的每一个帧进行描边，描边颜色与左边的类似」**。
  //
  // 为什么画在这里、而不是把描边烘进素材：
  //   1) "每一帧"自动成立（含以后新加的素材帧），不用每次重新导图
  //   2) 描边粗细在**屏幕像素**上是恒定的 —— 素材各组做过 `--normalize-height`，
  //      同一张图在不同组里缩放比不同（0.12~0.39），烘进素材的话粗细会跟着变
  //   3) 素材本身保持"原画"，随时能把描边关掉（width: 0）
  //
  // 颜色怎么定的（人家量了主人给的参考图）：
  //   参考图里左边那只的轮廓最外侧像素：**0% 是白色(>235)，24% 是很深的黑(<90)** ——
  //   也就是说她那条边是**近黑色**的线稿，不是白色贴纸圈。所以这里用近黑。
  //   （想要白色贴纸风：把 color 改成 '#ffffff' 就一行的事）
  // 主人 2026-09-24 第二次调整：**「线条太粗了，而且我希望连带头发和手都描一下」**
  //   · width 2 → 1（屏幕像素，DPR 1.5 下是 1.5 物理像素，够细也够清）
  //   · inner: true —— 除了**外轮廓**，还要把**内部边线**也描出来：
  //     手和脸/胸口的交界、头发和脸/黑蝴蝶结的交界，原来只有原画那条很细的灰线，
  //     缩到屏上就基本看不见了。
  //
  // 内部边线是怎么找的（人家踩过一版坑）：
  //   第一版直接比对相邻像素色差 → 素材是印刷品扫描，头发里有细条纹 + 缩小产生的摩尔纹，
  //   结果她脸上和裙子上全是黑麻点 ✗
  //   现在：**先模糊（把纹理抹平）→ 再找强颜色边界 → 再删掉面积太小的连通块**，三步都必要。
  //   参数是在 `scripts/preview-outline.js` 里离线调出来的（不用跑 Electron，几秒一轮）。
  //
  // ★ 主人 2026-09-24 第四次要求：
  //   「头发，眉毛，手，裙子只勾最外层，腿和脚」+「勾线的**粗细**、**黑白深度**两项
  //     同之前调播放速度一样给我两条横条」
  //   → 描边分两层：
  //     ① **部件线**：离线算好的掩码 `assets/build/edges/<组>/<帧>.png`
  //        （`scripts/make-edge-masks.js` 生成：按颜色把画面切成部件区域，只在"跨部件"的
  //          交界上画线；**裙子的黑白条纹被明确排除** = "只勾最外层"）
  //     ② **外轮廓**：alpha 形状往外扩一圈（每帧自动都有）
  //   两条横条（在待办面板下方，沿用以前那个调速滑条的样式）实时调：
  //     · 粗细 0~4 屏幕像素   · 黑白深浅 0=纯白 → 100=纯黑
  const OUTLINE = {
    width: 0.25,   // 部件线粗细（屏幕像素，0.25 步进）——主人调出来定死的值
    depth: 62,     // 深浅（0~100，越大越黑）——主人调出来定死的值（62 → rgb(97,97,97)）
    ring: 0.25,    // 外轮廓粗细，跟滑条联动（一个滑条管两处）
  };
  // ★ 主人 2026-09-24：「这里的白色蝴蝶可以不描」——
  //   靠近动作里那片压在脸上的白叶子（看着像白蝴蝶）不要描边。
  //   用**归一化矩形**把它从"外轮廓层"和"部件线层"里挖掉（人物本体照常画）。
  //   x/y/w/h 都是相对帧画布的比例，0~1；要加别的地方照这个格式加就行。
  const OUTLINE_EXCLUDE = {
    hover: [{ x: 0.20, y: 0.30, w: 0.24, h: 0.28 }],
  };
  const outlineColor = () => {
    const v = Math.round(255 * (1 - Math.max(0, Math.min(100, OUTLINE.depth)) / 100));
    return `rgb(${v},${v},${v})`;
  };
  // 一圈单位方向（16 个），描边 = 把这些方向各画一遍"剪影/掩码"
  const OUTLINE_RING = (() => {
    const ring = [];
    for (let i = 0; i < 16; i++) {
      const a = (Math.PI * 2 * i) / 16;
      ring.push([Math.cos(a), Math.sin(a)]);
    }
    return ring;
  })();
  // 缓存：key 里带"线色 + 粗细"，滑条一变就整体清空（很便宜）
  const silCache = new Map();     // 剪影（外轮廓用）
  const maskCache = new Map();    // 部件线掩码（染色 + 加粗）
  function clearOutlineCache(reason) {
    silCache.clear();
    maskCache.clear();
    dlog('outline', `描边缓存已清空（${reason}）：粗细=${OUTLINE.width} 深浅=${OUTLINE.depth} 外轮廓=${OUTLINE.ring}`);
  }
  // 把"不描的区域"从某一层里挖掉（例：靠近动作里那片白叶子）
  function punchExclusions(g2, group, W, H) {
    const rects = OUTLINE_EXCLUDE[group];
    if (!rects || !rects.length) return;
    for (const r of rects) g2.clearRect(r.x * W, r.y * H, r.w * W, r.h * H);
  }
  // 剪影：把某一帧的 alpha 形状填成线色
  function silhouetteOf(group, idx, w, h) {
    const key = `${group}#${idx}@${Math.round(w)}x${Math.round(h)}#${outlineColor()}`;
    const hit = silCache.get(key);
    if (hit) return hit;
    const img = spriteGroups[group] && spriteGroups[group].images[idx];
    if (!img) return null;
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g2 = c.getContext('2d');
    g2.imageSmoothingEnabled = true;
    g2.imageSmoothingQuality = 'high';
    g2.drawImage(img, 0, 0, W, H);
    g2.globalCompositeOperation = 'source-in';
    g2.fillStyle = outlineColor();
    g2.fillRect(0, 0, W, H);
    punchExclusions(g2, group, W, H);   // 不描的区域（白蝴蝶）
    silCache.set(key, c);
    return c;
  }
  // 部件线：把掩码染成线色，并按"粗细"加粗（多画几圈偏移）
  function edgeLayerOf(group, idx, w, h) {
    const key = `${group}#${idx}@${Math.round(w)}x${Math.round(h)}#${outlineColor()}#${OUTLINE.width}`;
    const hit = maskCache.get(key);
    if (hit) return hit;
    const g0 = spriteGroups[group];
    const mask = g0 && g0.edges && g0.edges[idx];
    if (!mask || !mask.complete || !mask.naturalWidth) return null;
    const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    const tint = document.createElement('canvas');
    tint.width = W; tint.height = H;
    const t2 = tint.getContext('2d');
    t2.imageSmoothingEnabled = true;
    t2.imageSmoothingQuality = 'high';
    t2.drawImage(mask, 0, 0, W, H);
    t2.globalCompositeOperation = 'source-in';
    t2.fillStyle = outlineColor();
    t2.fillRect(0, 0, W, H);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g2 = out.getContext('2d');
    // 基础线 ≈ 0.25px（掩码生成时按这个粗细预加粗过），滑条再往上加粗
    const grow = Math.max(0, OUTLINE.width - 0.25);
    if (grow === 0) {
      g2.drawImage(tint, 0, 0);
    } else {
      for (const [ox, oy] of OUTLINE_RING) g2.drawImage(tint, ox * grow, oy * grow);
    }
    punchExclusions(g2, group, W, H);   // 不描的区域（白蝴蝶）
    maskCache.set(key, out);
    return out;
  }

  function drawSpriteFrame(group, idx) {
    const g = spriteGroups[group];
    if (!g || !g.images[idx] || !ctx) return false;
    const img = g.images[idx];
    if (!img.complete || !img.naturalWidth) return false;
    // 给描边留出边距（否则贴到画布边缘的那几帧，描边会被裁掉一圈；多留 1px 余量）
    const pad = Math.max(OUTLINE.ring, OUTLINE.width) + 1;
    const scale = Math.min((CW - pad * 2) / img.naturalWidth, (CH - pad * 2) / img.naturalHeight);
    const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
    const dx = (CW - w) / 2, dy = (CH - h) / 2;
    ctx.clearRect(0, 0, CW, CH);
    // ① 外轮廓（画在最下面）
    if (OUTLINE.ring > 0) {
      const sil = silhouetteOf(group, idx, w, h);
      if (sil) {
        for (const [ox, oy] of OUTLINE_RING) {
          ctx.drawImage(sil, dx + ox * OUTLINE.ring, dy + oy * OUTLINE.ring, w, h);
        }
      }
    }
    // ② 原图
    ctx.drawImage(img, dx, dy, w, h);
    // ③ 部件线（头发/眉毛/手/腿脚…；裙子黑白条纹不在掩码里）
    if (OUTLINE.width > 0) {
      const edge = edgeLayerOf(group, idx, w, h);
      if (edge) ctx.drawImage(edge, dx, dy, w, h);
    }
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
    // 保持动作优先：不管是因为"一次性动作播完了"还是"鼠标移开了"，都回到保持中的那个动作
    if (poseHold.group && spriteGroups[poseHold.group]) {
      playGroup(poseHold.group, { loop: true, force: true });
      dlog('sprite-play', `${reason} → 回到保持动作「${poseHold.group}」`);
      return;
    }
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
      if (g && ts - lastAdvance >= (g.delays[spriteState.activeFrame] || 204)) {
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
      const images = [], delays = [], edges = [];
      // 帧图 + 它们的"部件描边掩码"（可选，没生成就是 null）
      await Promise.all(g.frames.map((f, i) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => { images[i] = img; delays[i] = f.delayMs; resolve(true); };
        img.onerror = () => resolve(false);
        img.src = f.url;
        if (f.edgeUrl) {
          const em = new Image();
          em.onload = () => { edges[i] = em; };
          em.src = f.edgeUrl;
        }
      })));
      const loaded = images.filter((im) => im && im.naturalWidth).length;
      if (loaded !== g.frames.length) {
        dlog('sprite-load', `动作「${name}」仅 ${loaded}/${g.frames.length} 帧可用，跳过`);
        continue;
      }
      spriteGroups[name] = { images, delays, edges };
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

    // 气泡列宽度：由 CSS 定（气泡固定 150px，放在窗口最左）。
    // ⚠️ 这里**不再把 --bubble-w 写回 CSS**（那只影响网格里那条给她的占位列，
    //   而她已经改成绝对定位、不占网格），只回报给主进程算窗口宽度。
    setTimeout(() => {
      try {
        const cs = getComputedStyle(bubble);
        const bubbleW = bubble.offsetWidth || 150;
        const colW = Math.round(bubbleW + (parseFloat(cs.left) || 0) + 16);
        const spriteW = Math.round(parseFloat(getComputedStyle(pet).getPropertyValue('--sprite-w')) || 0);
        if (colW > 120 && colW < 400) window.pet.setBubbleWidth(colW);
        if (spriteW > 80) window.pet.setPetColumn(spriteW);
        dlog('bubble-col', `气泡列 = ${colW}px（气泡 ${bubbleW}）；桌宠列 = ${spriteW}px；视口 ${window.innerWidth}`);
        relayoutBubble();
      } catch { /* 量不出来就用主进程兜底值，顶多气泡窄一点 */ }
    }, 250);

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

  // ---------- 描边的两条调试横条：已按主人要求拆除 ----------
  // 主人调好「0.25px / 62%」之后说"可以去掉调试线了"，所以：
  //   · 面板里那两条横条（HTML/CSS）删了
  //   · 自检入口 __petTest.setOutline 也删了（跟当初调速滑条一个流程）
  // 数值固化在上面 OUTLINE 里；以后要再调，照 devlog/round-23.md 的说明加回来即可。
  clearOutlineCache('启动');   // 让第一帧就用固化的参数建好缓存

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
      closeButtonExists: !!document.getElementById('memoClose'),
      panelRect: memoEl ? (() => { const r = memoEl.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
      panelInViewport: memoEl ? (() => { const r = memoEl.getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })() : null,
      addedTotal: memoState.added,
      removedTotal: memoState.removed,
      renders: memoState.renders,
      opens: memoState.opens,
      closes: memoState.closes,
      // 对话输入（第 25 轮）：主进程的自检要能"看见"这一行确实在界面里
      chat: {
        exists: !!chatInput,
        sending: chatState.sending,
        disabled: chatInput ? chatInput.disabled : null,
        placeholder: chatInput ? chatInput.placeholder : null,
        focused: !!(chatInput && document.activeElement === chatInput),
        sends: chatState.sends,
        replies: chatState.replies,
        errors: chatState.errors,
        lastText: chatState.lastText,
        lastKind: chatState.lastKind,
        lastMs: chatState.lastMs,
        rect: chatInput ? (() => { const r = chatInput.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })() : null,
        inViewport: chatInput ? (() => { const r = chatInput.getBoundingClientRect();
          return r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })() : null,
      },
    };
  }

  window.__petTest = {
    click: () => pet.click(),
    action: (n) => {
      // 第 32 轮：这里改成走**和真实菜单完全同一条路**（requestLine → 主进程判定）。
      // 以前它直接念本地台词，于是自检永远看不到"接 API 后走模型"那条路 —— 那正是最该被盯住的路。
      if (n === 'headpat') { say(pick(LINES.pat)); playAnim('pat', 720); return Promise.resolve(pick(LINES.pat)); }
      if (n === 'happy') { playAnim('hop', 520); return requestLine('happy', '__petTest'); }
      if (n === 'happyOff') { return requestLine('happyOff', '__petTest'); }
      if (n === 'angry') { playAnim('angry', 1300); return requestLine('angry', '__petTest'); }
      return Promise.resolve(null);
    },
    // 描边调试入口 setOutline 已按主人要求删除（数值固化在 renderer.js 的 OUTLINE 里）
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
    // 布局取证（一行把"网格到底怎么排的"摊开；排查人物/气泡被挤偏时用）
    layoutProbe: () => {
      const s = document.querySelector('.scene');
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return { rect: [Math.round(b.left), Math.round(b.right)], w: Math.round(b.width),
                 display: cs.display, col: cs.gridColumnStart, js: cs.justifySelf, margin: cs.marginLeft + '/' + cs.marginRight }; };
      // 逐个子元素扫一遍：谁在气泡和她之间占着位置，一眼就能看出来
      const kids = [...s.children].map((e) => { const b = e.getBoundingClientRect();
        return (e.id || e.className || e.tagName) + '[' + Math.round(b.left) + ',' + Math.round(b.right) + ']'; });
      const memoEl2 = document.getElementById('memo');
      const memoCs = memoEl2 ? getComputedStyle(memoEl2) : null;
      return { vp: innerWidth, cols: getComputedStyle(s).gridTemplateColumns,
               memoStyle: memoEl2 ? { inlineLeft: memoEl2.style.left, inlinePos: memoEl2.style.position, cssLeft: memoCs.left, cssPos: memoCs.position, offsetLeft: memoEl2.offsetLeft } : null,
               scene: [Math.round(s.getBoundingClientRect().left), Math.round(s.getBoundingClientRect().right)],
               sceneClass: s.className, bubbleVar: getComputedStyle(s).getPropertyValue('--bubble-w').trim(),
               spriteVar: getComputedStyle(s).getPropertyValue('--sprite-w').trim(),
               kids, pet: r('#pet'), sprite: r('#sprite'), memo: r('#memo'), bubble: r('#bubble') };
    },
    // 布局取证：把"网格到底怎么排的"一次性摊出来（第 26 轮排查气泡列用的）
    layoutSnapshot: () => {
      const s = document.querySelector('.scene');
      const r = (sel) => { const e = document.querySelector(sel); if (!e) return null;
        const b = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return { rect: [Math.round(b.left), Math.round(b.right)], display: cs.display,
                 gridColumn: cs.gridColumnStart + '/' + cs.gridColumnEnd, justifySelf: cs.justifySelf,
                 margin: cs.marginLeft + ',' + cs.marginRight, width: cs.width }; };
      return {
        vp: window.innerWidth,
        cols: getComputedStyle(s).gridTemplateColumns,
        sceneRect: (() => { const b = s.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right)]; })(),
        sceneClass: s.className,
        memo: r('#memo'), pet: r('#pet'), bubble: r('#bubble'),
      };
    },
    // 对话（第 25 轮）：自检从主进程驱动这一行输入框，走的路径和真人打字完全一样
    chatSnapshot: () => memoSnapshot().chat,
    chatSend: (text) => sendChatLine(text),
    // 直接让气泡说一句（自检用：验证"长回复时气泡变宽，偏移量跟着重算，不许压回面板上"）
    sayLine: (text) => { say(String(text)); return true; },
    // 兜底心跳开关（见上面那段注释：自检默认关，验它的时候临时开）
    setHoverWatchdog: (on) => { hoverWatchdogOn = !!on; return hoverWatchdogOn; },
    hoverWatchdogState: () => ({ on: hoverWatchdogOn, ticks: hoverWatchdogTicks, fixes: hoverWatchdogFixes }),
    // 找一个**确实没有实体像素**的点（自检用：把鼠标"移开"要移到真空气上）
    emptyPoint: () => {
      const tl = spriteTimeline.name || spriteState.baseGroup;
      const rec = tl ? alphaMapOf(tl, spriteState.activeFrame | 0) : null;
      const r = pet.getBoundingClientRect();
      if (!rec) return { ok: false };
      const cw = canvas.clientWidth || rec.w;
      const ch = canvas.clientHeight || rec.h;
      let found = null;
      for (let y = 0; y < rec.h && !found; y += 2) {
        for (let x = 0; x < rec.w; x += 2) {
          if (rec.data[y * rec.w + x] === 0) { found = { x, y }; break; }
        }
      }
      if (!found) return { ok: false };
      const clientX = Math.round(r.left + (found.x + 0.5) / rec.w * cw);
      const clientY = Math.round(r.top + (found.y + 0.5) / rec.h * ch);
      return { ok: true, clientX, clientY, selfCheck: pointOnCharacter(clientX, clientY) === false };
    },
    // 找一个**确实画在角色身上**的点（自检用）：像素判定改成逐像素之后，    // "矩形中心"可能正好是空气（比如脸上的空隙），合成事件移到那儿就不再算"靠近"。
    // 从位图里扫出第一个实体像素，再换算回窗口坐标。
    solidPoint: () => {
      const tl = spriteTimeline.name || spriteState.baseGroup;
      const rec = tl ? alphaMapOf(tl, spriteState.activeFrame | 0) : null;
      const r = pet.getBoundingClientRect();
      if (!rec) return { ok: false, rect: [r.left, r.top, r.right, r.bottom] };
      const cw = canvas.clientWidth || rec.w;
      const ch = canvas.clientHeight || rec.h;
      let found = null;
      for (let y = 0; y < rec.h && !found; y += 2) {
        for (let x = 0; x < rec.w; x += 2) {
          if (rec.data[y * rec.w + x] === 1) { found = { x, y }; break; }
        }
      }
      if (!found) return { ok: false, painted: rec.painted, rect: [r.left, r.top, r.right, r.bottom] };
      const clientX = Math.round(r.left + (found.x + 0.5) / rec.w * cw);
      const clientY = Math.round(r.top + (found.y + 0.5) / rec.h * ch);
      return {
        ok: true,
        clientX, clientY,
        // 自证：这个点自己判一遍，应该是 true（不是的话说明坐标映射有偏差，一眼能看出来）
        selfCheck: pointOnCharacter(clientX, clientY),
        frame: tl + '#' + (spriteState.activeFrame | 0),
        painted: rec.painted, mapSize: [rec.w, rec.h], canvasSize: [cw, ch],
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      };
    },
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
      // 漏掉了会很难查：长回复时气泡变宽，偏移量必须跟着重算，否则它又压回面板上
      bubbleRect: (() => { const r = bubble.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }; })(),
      // 气泡躲面板的现场数据（主人要求"回复要生成在另一侧"）
      bubbleLayout: (() => {
        const br = bubble.getBoundingClientRect();
        const pr = memoEl ? memoEl.getBoundingClientRect() : { left: 0, right: 0, width: 0 };
        const panelled = memoState.open && pr.width > 0;
        return {
          chatting, panelSide: panelSide || null, shift: bubble.style.getPropertyValue('--bubble-shift') || '0px',
          bubble: { left: Math.round(br.left), right: Math.round(br.right) },
          panel: { left: Math.round(pr.left), right: Math.round(pr.right), width: Math.round(pr.width) },
          winW: window.innerWidth,
          // 面板在右 → 气泡要整个在面板左边；面板在左 → 气泡要整个在面板右边
          panelOnRight: panelled ? (pr.left > 0) : null,
          overlapsPanel: panelled ? !(br.right <= pr.left + 1 || br.left >= pr.right - 1) : false,
          gap: panelled ? (pr.left > 0 ? Math.round(pr.left - br.right) : Math.round(br.left - pr.right)) : null,
        };
      })(),
      bubbleInViewport: (() => { const r = bubble.getBoundingClientRect();
        return r.top >= 0 && r.left >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; })(),
      lastHit, clickCount, sayCount, dragging,
      lastSay, lastSayAt, lineSeq: lineReqSeq,
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
        timeline: spriteTimeline.name
          ? { group: spriteTimeline.name, loop: spriteTimeline.loop }
          : null,
        // 保持动作（主人要求「开心」点一次就保持住，再点一次才退出）
        poseGroup: poseHold.group,
        // 描边设置（自检核对用：两条滑条调的就是这两个数）
        outline: {
          width: OUTLINE.width, depth: OUTLINE.depth, ring: OUTLINE.ring,
          color: outlineColor(), masks: maskCache.size, silhouettes: silCache.size,
          groupsWithEdges: Object.keys(spriteGroups).filter((k) => spriteGroups[k].edges && spriteGroups[k].edges.some((e) => e && e.complete)),
        },
        hovering: spriteState.hovering,
        hoverEnters: hoverState.enters,
        hoverExits: hoverState.exits,
        // 悬停 0.5 秒那套（自检用）：delays = 真的等到 500ms 的次数，cancels = 没等够就走的次数
        hoverDelay: { ms: HOVER_DELAY_MS, armed: hoverArmed, waiting: !!hoverTimer,
                      delays: hoverState.delays, cancels: hoverState.cancels },
        // 兜底心跳的计数（自检用：验证"鼠标移开但没收到事件"时它真的把动作复原了）
        hoverWatchdog: { on: hoverWatchdogOn, ticks: hoverWatchdogTicks, fixes: hoverWatchdogFixes },
        // 每组的原始帧延时（ms），供自检核对播放速度
        loadedDelays: (() => {
          const o = {};
          for (const [k, g] of Object.entries(spriteGroups)) o[k] = g.delays.slice();
          return o;
        })(),
      },
    }),
  };

  dlog('startup', `渲染层就绪（通用机制版）：视口=${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio} 画布=${CW}x${CH}`);
  console.log('[桌宠] 渲染层就绪（无内置主题形象，等待素材）');
})();
