// 设置窗口的逻辑（接入 API）
//
// 三条规矩（都是踩坑值钱的）：
//   1) **密钥只会往里写，不会往回读**：主进程发过来的只有 hasKey / 掩码，
//      输入框留空保存 = "不修改已存的密钥"，而不是"把密钥清空"。
//   2) 保存后不关闭窗口、也不打断主人：状态条上写清楚改了什么（地址/模型/记忆轮数）。
//   3) "测试连接"走的是**和正式对话完全同一条代码路径**（主进程 pet:api-test），
//      不另写一套 HTTP 逻辑 —— 否则测绿了、正式用却红，那才叫难查。
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
  presets: $('presets'),
  save: $('save'),
  test: $('test'),
  openCfg: $('openCfg'),
  status: $('status'),
  cfgPath: $('cfgPath'),
};

let savedView = null;   // 上一次从主进程拿到的安全视图（用于显示"已存的密钥长什么样"）

function setStatus(kind, text) {
  el.status.className = 'status' + (kind ? ' ' + kind : '');
  el.status.textContent = text;
}

function syncRangeLabels() {
  el.tempVal.textContent = Number(el.temperature.value).toFixed(1);
  el.tokVal.textContent = el.maxTokens.value;
  el.histVal.textContent = el.historyRounds.value;
  el.toVal.textContent = el.timeoutMs.value;
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
  el.apiKey.value = '';
  el.apiKey.placeholder = view.hasKey ? '已保存（留空 = 不修改）' : 'sk-…';
  el.keyTip.textContent = view.hasKey
    ? `已存的密钥：${view.maskedKey}（留空保存 = 不改动；想换就直接粘贴新的）`
    : '还没填密钥。填好保存后，点「测试连接」验一下。';
  el.cfgPath.textContent = view.configPath || '…';
  syncRangeLabels();
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
  };
  // ★ 空的密钥字段 = "不动已存的密钥"，绝不发空字符串过去（否则会把好好的密钥清掉）
  const typed = el.apiKey.value.trim();
  if (typed) patch.apiKey = typed;
  return patch;
}

async function loadAll() {
  try {
    const view = await window.pet.apiConfigGet();
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
    setStatus('ok', `已保存 ✅ 地址 ${view.baseUrl} · 模型 ${view.model} · 密钥 ${view.hasKey ? '已设置' : '未设置'}`
      + `\n对话${view.enabled ? '已启用' : '已关闭（她仍会说本地台词）'}，记忆 ${view.historyRounds} 轮，超时 ${view.timeoutMs}ms。`);
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

el.openCfg.addEventListener('click', async () => {
  const r = await window.pet.openConfigFile();
  setStatus(r.ok ? '' : 'bad', r.ok ? `已在资源管理器中选中：${r.path}` : `打不开：${r.error || ''}`);
});

el.toggleKey.addEventListener('click', () => {
  const show = el.apiKey.type === 'password';
  el.apiKey.type = show ? 'text' : 'password';
  el.toggleKey.textContent = show ? '隐藏' : '显示';
});

for (const r of [el.temperature, el.maxTokens, el.historyRounds, el.timeoutMs]) {
  r.addEventListener('input', syncRangeLabels);
}

loadAll();
