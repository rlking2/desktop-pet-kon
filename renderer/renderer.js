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
  function say(text, ms = 2600) {
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
  let dragging = false;
  pet.addEventListener('mousedown', async (e) => {
    if (e.button !== 0 || e.detail > 1) return;
    const bounds = await window.pet.getBounds();
    dragging = true;
    pet.classList.add('dragging');
    window.pet.dragStart({
      cursorX: Math.round(e.screenX),
      cursorY: Math.round(e.screenY),
      winX: bounds.x,
      winY: bounds.y,
    });
    e.preventDefault();
  });

  const stopDrag = () => {
    if (!dragging) return;
    dragging = false;
    pet.classList.remove('dragging');
    window.pet.dragEnd();
  };
  window.addEventListener('mouseup', stopDrag);
  window.addEventListener('blur', stopDrag);

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
    window.pet.openContextMenu();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.pet.quit();
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
    },
    state: () => ({
      petClasses: pet.className,
      bubbleShown: bubble.classList.contains('show'),
      bubbleText: bubble.textContent,
      lastHit,
    }),
  };

  console.log('[鲸鱼娘] 桌宠已就位，尾鳍在线。');
})();
