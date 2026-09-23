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

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.pet.openContextMenu();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.pet.quit();
    if (e.key.toLowerCase() === 'p') window.pet.onAction ? null : null;
  });

  // 自检用：把交互能力暴露成一个可调用入口，让人家能自动验证
  window.__petTest = {
    click: () => pet.click(),
    action: (n) => {
      if (n === 'headpat') { say(pick(PAT_LINES)); playAnim('pat', 720); }
      if (n === 'angry') { say(pick(ANGRY_LINES)); playAnim('angry', 1300); }
    },
    state: () => ({
      petClasses: pet.className,
      bubbleShown: bubble.classList.contains('show'),
      bubbleText: bubble.textContent,
    }),
  };

  console.log('[鲸鱼娘] 桌宠已就位，尾鳍在线。');
})();
