// 设置窗口的逻辑（接入 API + 她的性格 + 她的话）
//
// 四条规矩（都是踩坑值钱的）：
//   1) **密钥只会往里写，不会往回读**：主进程发过来的只有 hasKey / 掩码，
//      输入框留空保存 = "不修改已存的密钥"，而不是"把密钥清空"。
//   2) 保存后不关闭窗口、也不打断主人：状态条上写清楚改了什么。
//   3) "测试连接"走的是**和正式对话完全同一条代码路径**（主进程 pet:api-test），
//      不另写一套 HTTP 逻辑 —— 否则测绿了、正式用却红，那才叫难查。
//   4) （第 32 轮）**表单结构不许在这里写死**：人格有哪些字段、哪些时机能开关，
//      都由主进程把 lib/action-lines.js 里的那张表发过来，这里只负责生成界面。
//      想加一项人格设定 → 改 lib/action-lines.js 的 PERSONA_FIELDS，这里自动多一个框。
const $ = (id) => document.getElementById(id);

const el = {
  enabled: $('enabled'),
  baseUrl: $('baseUrl'),
  apiKey: $('apiKey'),
  toggleKey: $('toggleKey'),
  keyTip: $('keyTip'),
  model: $('model'),
  temperature: $('temperature'),
  tempVal: $('tempVal'),
  maxTokens: $('maxTokens'),
  tokVal: $('tokVal'),
  historyRounds: $('historyRounds'),
  histVal: $('histVal'),
  timeoutMs: $('timeoutMs'),
  toVal: $('toVal'),
  systemPrompt: $('systemPrompt'),
  personaPresets: $('personaPresets'),
  personaFields: $('personaFields'),
  previewPrompt: $('previewPrompt'),
  actionToggles: $('actionToggles'),
  idleEnabled: $('idleEnabled'),
  idlePreview: $('idlePreview'),
  idleMinutes: $('idleMinutes'),
  idleMinVal: $('idleMinVal'),
  idlePerDay: $('idlePerDay'),
  idleDayVal: $('idleDayVal'),
  quietFrom: $('quietFrom'),
  quietTo: $('quietTo'),
  muted: $('muted'),
  tryLine: $('tryLine'),
  presets: $('presets'),
  save: $('save'),
  test: $('test'),
  openCfg: $('openCfg'),
  status: $('status'),
  cfgPath: $('cfgPath'),
};

let savedView = null;   // 上一次从主进程拿到的安全视图（用于显示"已存的密钥长什么样"）
let schema = null;      // { personaFields, personaPresets, actionLabels, actionKeys, idleLimits }
const personaInputs = {};   // key → textarea（按主进程给的字段表生成）
const actionInputs = {};    // action → checkbox

function setStatus(kind, text) {
  el.status.className = 'status' + (kind ? ' ' + kind : '');
  el.status.textContent = text;
}

function syncRangeLabels() {
  el.tempVal.textContent = Number(el.temperature.value).toFixed(1);
  el.tokVal.textContent = el.maxTokens.value;
  el.histVal.textContent = el.historyRounds.value;
  el.toVal.textContent = el.timeoutMs.value;
  el.idleMinVal.textContent = el.idleMinutes.value;
  el.idleDayVal.textContent = el.idlePerDay.value;
}

// ---------- 按主进程给的表生成界面（第 32 轮） ----------
function buildPersonaForm() {
  el.personaFields.innerHTML = '';
  for (const f of schema.personaFields) {
    const wrap = document.createElement('div');
    wrap.className = 'row persona-field';
    const lab = document.createElement('label');
    lab.className = 'label';
    lab.textContent = f.label;
    lab.setAttribute('for', 'persona-' + f.key);
    const ta = document.createElement('textarea');
    ta.id = 'persona-' + f.key;
    ta.rows = String(f.rows || 2);
    ta.spellcheck = false;
    ta.placeholder = f.placeholder || '';
    wrap.appendChild(lab);
    wrap.appendChild(ta);
    el.personaFields.appendChild(wrap);
    personaInputs[f.key] = ta;
  }
}

function buildPersonaPresets() {
  el.personaPresets.innerHTML = '';
  for (const p of schema.personaPresets) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = p.label;
    b.dataset.preset = p.id;
    b.addEventListener('click', () => {
      for (const [k, ta] of Object.entries(personaInputs)) {
        ta.value = (p.persona && p.persona[k]) || '';
      }
      for (const other of el.personaPresets.querySelectorAll('button')) other.classList.remove('on');
      b.classList.add('on');
      setStatus('', `已套用性格预设「${p.label}」——别忘了点「保存」。`
        + (p.id === 'custom' ? '（"完全自定义"会把上面清空，空着的地方用内置默认值补。）' : ''));
    });
    el.personaPresets.appendChild(b);
  }
}

function buildActionToggles() {
  el.actionToggles.innerHTML = '';
  for (const a of schema.actionKeys) {
    const lab = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.action = a;
    const span = document.createElement('span');
    span.textContent = schema.actionLabels[a] || a;
    lab.appendChild(cb);
    lab.appendChild(span);
    el.actionToggles.appendChild(lab);
    actionInputs[a] = cb;
    cb.addEventListener('change', refreshIdlePreview);
  }
}

function buildHourSelects() {
  for (const sel of [el.quietFrom, el.quietTo]) {
    sel.innerHTML = '';
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = String(h);
      o.textContent = `${String(h).padStart(2, '0')}:00`;
      sel.appendChild(o);
    }
  }
}

function setPresetActive(persona) {
  const filled = Object.values(persona || {}).some((v) => String(v || '').trim());
  for (const b of el.personaPresets.querySelectorAll('button')) b.classList.remove('on');
  // 分项人格非空时，高亮"和它逐字相同"的那个预设（否则不高亮任何一项 —— 说明是手改过的）
  for (const p of schema.personaPresets) {
    const same = Object.keys(personaInputs).every((k) => String((persona || {})[k] || '') === String((p.persona || {})[k] || ''));
    if (same) { const btn = el.personaPresets.querySelector(`button[data-preset="${p.id}"]`); if (btn) btn.classList.add('on'); return; }
  }
  if (!filled) {
    const btn = el.personaPresets.querySelector('button[data-preset="default"]');
    if (btn) btn.classList.add('on');
  }
}

// "空闲时她会说什么"的人话预览：把当前勾选状态翻译成一句主人能看懂的话
function refreshIdlePreview() {
  const idleOn = el.idleEnabled.checked;
  const anyAction = Object.values(actionInputs).some((c) => c.checked);
  const mins = el.idleMinutes.value;
  const day = el.idlePerDay.value;
  const from = String(el.quietFrom.value).padStart(2, '0');
  const to = String(el.quietTo.value).padStart(2, '0');
  const quiet = el.quietFrom.value === el.quietTo.value ? '不设静音时段' : `${from}:00 – ${to}:00 不开口`;
  if (!idleOn) { el.idlePreview.textContent = '已关掉：她不会自己找你说话（你打字聊她照常回）。'; return; }
  if (!anyAction) { el.idlePreview.textContent = '注意：上面四个时机一个都没打勾 → 接上 API 后她也不会用大模型说话，只会念本地台词。'; return; }
  el.idlePreview.textContent = `安静 ${mins} 分钟她会主动说一句，每天最多 ${day === '0' ? '不限' : day + ' 次'}；${quiet}。`;
}

// 把主进程的安全视图铺到表单上（**注意：apiKey 输入框永远是空的**）
function fill(view) {
  savedView = view;
  el.enabled.checked = !!view.enabled;
  el.baseUrl.value = view.baseUrl || '';
  el.model.value = view.model || '';
  el.temperature.value = String(view.temperature);
  el.maxTokens.value = String(view.maxTokens);
  el.historyRounds.value = String(view.historyRounds);
  el.timeoutMs.value = String(view.timeoutMs);
  el.systemPrompt.value = view.systemPrompt || '';
  el.apiKey.value = '';
  el.apiKey.placeholder = view.hasKey ? '已保存（留空 = 不修改）' : 'sk-…';
  el.keyTip.textContent = view.hasKey
    ? `已存的密钥：${view.maskedKey}（留空保存 = 不改动；想换就直接粘贴新的）`
    : '还没填密钥。填好保存后，点「测试连接」验一下。';

  // 人格：先铺字段值，再高亮预设
  for (const [k, ta] of Object.entries(personaInputs)) ta.value = (view.persona && view.persona[k]) || '';
  setPresetActive(view.persona);
  // 她的话
  for (const [a, cb] of Object.entries(actionInputs)) cb.checked = view.actionModel ? view.actionModel[a] !== false : true;
  el.idleEnabled.checked = view.idle ? !!view.idle.enabled : true;
  el.idleMinutes.value = String(view.idle ? view.idle.minutes : 15);
  el.idlePerDay.value = String(view.idle ? view.idle.perDay : 12);
  el.quietFrom.value = String(view.idle ? view.idle.quietFrom : 23);
  el.quietTo.value = String(view.idle ? view.idle.quietTo : 8);
  el.muted.checked = !!view.muted;

  el.cfgPath.textContent = view.configPath || '…';
  syncRangeLabels();

  // 走模型的总闸门没满足时，把"为什么"直接写在状态区（主人最常问的就是这一句）
  if (!view.actionModelReady) {
    const why = {
      disabled: '「启用对话」没打开 → 她只用本地台词。',
      noKey: 'API 密钥还没填 → 她只用本地台词。',
      noModel: '接口地址或模型名没填 → 她只用本地台词。',
    }[view.actionModelReadyReason] || '';
    if (why) el.idlePreview.textContent = why;
  }
  refreshIdlePreview();
}

function collect() {
  const patch = {
    enabled: el.enabled.checked,
    baseUrl: el.baseUrl.value.trim(),
    model: el.model.value.trim(),
    temperature: Number(el.temperature.value),
    maxTokens: Number(el.maxTokens.value),
    historyRounds: Number(el.historyRounds.value),
    timeoutMs: Number(el.timeoutMs.value),
    systemPrompt: el.systemPrompt.value.trim(),
    muted: el.muted.checked,
    persona: {},
    actionModel: {},
    idle: {
      enabled: el.idleEnabled.checked,
      minutes: Number(el.idleMinutes.value),
      perDay: Number(el.idlePerDay.value),
      quietFrom: Number(el.quietFrom.value),
      quietTo: Number(el.quietTo.value),
    },
  };
  for (const [k, ta] of Object.entries(personaInputs)) patch.persona[k] = ta.value.trim();
  for (const [a, cb] of Object.entries(actionInputs)) patch.actionModel[a] = cb.checked;
  // ★ 空的密钥字段 = "不动已存的密钥"，绝不发空字符串过去（否则会把好好的密钥清掉）
  const typed = el.apiKey.value.trim();
  if (typed) patch.apiKey = typed;
  return patch;
}

async function loadAll() {
  try {
    const view = await window.pet.apiConfigGet();
    // 表单结构必须先按主进程给的表建好，再 fill —— 否则 fill 时拿不到那些输入框
    schema = {
      personaFields: view.personaFields,
      personaPresets: view.personaPresets,
      actionLabels: view.actionLabels,
      actionKeys: view.actionKeys,
      idleLimits: view.idleLimits,
    };
    buildPersonaForm();
    buildPersonaPresets();
    buildActionToggles();
    buildHourSelects();
    fill(view);
    setStatus('', view.ready
      ? `已配置：${view.baseUrl} · ${view.model}${view.hasKey ? '' : '（但还没有密钥）'}`
      : '还没配置好。填上接口地址 + 密钥 + 模型名，保存后点「测试连接」。');
  } catch (err) {
    setStatus('bad', '读取设置失败：' + (err && err.message));
  }
  try {
    const presets = await window.pet.apiPresets();
    el.presets.innerHTML = '';
    for (const p of presets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.label;
      b.addEventListener('click', () => {
        el.baseUrl.value = p.baseUrl;
        el.model.value = p.model;
        for (const other of el.presets.querySelectorAll('button')) other.classList.remove('on');
        b.classList.add('on');
        setStatus('', `已套用「${p.label}」的地址和模型，别忘了填这个服务商的密钥，然后保存。`);
      });
      el.presets.appendChild(b);
    }
  } catch { /* 预设拿不到不影响手填 */ }
}

el.save.addEventListener('click', async () => {
  el.save.disabled = true;
  setStatus('busy', '正在保存…');
  try {
    const view = await window.pet.apiConfigSave(collect());
    fill(view);
    const onCount = Object.values(view.actionModel).filter(Boolean).length;
    setStatus('ok', `已保存 ✅ 地址 ${view.baseUrl} · 模型 ${view.model} · 密钥 ${view.hasKey ? '已设置' : '未设置'}`
      + `\n对话${view.enabled ? '已启用' : '已关闭（她仍会说本地台词）'}，记忆 ${view.historyRounds} 轮，超时 ${view.timeoutMs}ms。`
      + `\n她的话：${onCount}/4 个时机走大模型；空闲 ${view.idle.enabled ? `每安静 ${view.idle.minutes} 分钟一次、每天最多 ${view.idle.perDay === 0 ? '不限' : view.idle.perDay + ' 次'}` : '已关'}`
      + `${view.muted ? '；当前【静音中】' : ''}。`
      + (view.actionModelReady ? '' : '\n⚠️ 现在还不满足"走大模型"的条件，她会先用本地台词（原因见上面的提示）。'));
  } catch (err) {
    setStatus('bad', '保存失败：' + (err && err.message));
  } finally {
    el.save.disabled = false;
  }
});

el.test.addEventListener('click', async () => {
  el.test.disabled = true;
  // 先保存再测：不然测的是"上一次存进去的配置"，主人会以为改了没用
  try { fill(await window.pet.apiConfigSave(collect())); } catch { /* 保存失败也继续测，测出来的错更直观 */ }
  setStatus('busy', '正在连她的脑子…（最多等 20 秒）');
  try {
    const res = await window.pet.apiTest();
    if (res.ok) {
      setStatus('ok', `连通 ✅ ${res.ms}ms\n她说：「${res.raw || res.text}」\n模型 ${res.model || '?'}`
        + (res.usage ? ` · 用量 ${JSON.stringify(res.usage)}` : '')
        + '\n现在左键点开她，在「和她说…」那一行打字就能聊了。');
    } else {
      setStatus('bad', `没连上 ❌ 类型=${res.kind}${res.status ? ` HTTP ${res.status}` : ''} ${res.ms ? `${res.ms}ms` : ''}\n`
        + `她会说：「${res.text}」\n${res.detail ? `技术细节：${res.detail}\n` : ''}`
        + '排查顺序：① 密钥有没有复制全 ② 地址对不对（OpenAI 兼容网关通常要带 /v1）'
        + '③ 模型名是否拼错 ④ 余额/额度 ⑤ 网络能不能出去。');
    }
  } catch (err) {
    setStatus('bad', '测试失败：' + (err && err.message));
  } finally {
    el.test.disabled = false;
  }
});

// 「试一句」：让大模型按**当前人格**现场说一句；把实际发出去的提示词也显示出来（看得见才好调）
el.tryLine.addEventListener('click', async () => {
  el.tryLine.disabled = true;
  setStatus('busy', '让她按现在的人格说一句…（最多等 20 秒）');
  try {
    // 先存下来：试的那一句必须用"你眼前这套设置"，不能用上一次存的
    fill(await window.pet.apiConfigSave(collect()));
    const res = await window.pet.actionLine({ action: 'idle', userText: '（主人想看看你现在是什么样子）' });
    const preview = await window.pet.debugPrompt({ action: 'idle' });
    const lines = [
      res && res.source === 'model'
        ? `她说：「${res.text}」（${res.ms}ms，来自大模型）`
        : `她说：「${res.text}」（走的是**本地台词**，原因=${res && res.reason}）`,
    ];
    if (preview && preview.system) lines.push('', '—— 实际发出去的提示词 ——', preview.system);
    setStatus(res && res.source === 'model' ? 'ok' : '', lines.join('\n'));
  } catch (err) {
    setStatus('bad', '试一句失败：' + (err && err.message));
  } finally {
    el.tryLine.disabled = false;
  }
});

el.previewPrompt.addEventListener('click', async () => {
  try {
    const preview = await window.pet.debugPrompt({ action: 'idle' });
    setStatus('', `—— 现在的提示词（时机：空闲开口）——\n${preview.system}`);
  } catch (err) {
    setStatus('bad', '拿不到提示词：' + (err && err.message));
  }
});

el.openCfg.addEventListener('click', async () => {
  const r = await window.pet.openConfigFile();
  setStatus(r.ok ? '' : 'bad', r.ok ? `已在资源管理器中选中：${r.path}` : `打不开：${r.error || ''}`);
});

el.toggleKey.addEventListener('click', () => {
  const show = el.apiKey.type === 'password';
  el.apiKey.type = show ? 'text' : 'password';
  el.toggleKey.textContent = show ? '隐藏' : '显示';
});

for (const r of [el.temperature, el.maxTokens, el.historyRounds, el.timeoutMs, el.idleMinutes, el.idlePerDay]) {
  r.addEventListener('input', () => { syncRangeLabels(); refreshIdlePreview(); });
}
el.idleEnabled.addEventListener('change', refreshIdlePreview);
el.quietFrom.addEventListener('change', refreshIdlePreview);
el.quietTo.addEventListener('change', refreshIdlePreview);

// 设置窗口一打开就通知主进程"主人理她了"：正在调人格的时候她不该自己冒出来说话
try { window.pet.userActive('settings-open'); } catch { /* 忽略 */ }

loadAll();
