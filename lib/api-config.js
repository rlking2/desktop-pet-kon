// API 设置：读写 + 校验（**只在主进程用**）
//
// 【为什么要单独一个文件、为什么密钥绝不进渲染层】
//   桌宠的渲染层是网页（CSP 是 default-src 'none'，连 fetch 都不许发），
//   而网页里的任何东西都可能被 XSS / 被开发者工具里的一段脚本读走。
//   所以规矩定死：
//     1) 密钥只存在主进程内存里 + 落盘到用户数据目录，**从不通过 IPC 发给渲染层**；
//     2) 要发给渲染层看的只有 `hasKey` / `maskedKey` 这类"能看出配没配、看不出是什么"的信息；
//     3) 想改密钥只能从设置窗口（那是**另一个窗口**，走的是同一套 IPC，但仍然只收不回传）。
//
// 【为什么配置文件放 userData 而不是程序目录】
//   %APPDATA%\dsh-desktop-pet\ 是用户数据目录：便携版和安装版共用同一份（见
//   electron-builder.config.js 里那段 extraMetadata 的注释），升级/换安装方式都不丢配置。
//   放程序目录的话，安装版一升级（NSIS 覆盖安装目录）就被清掉了。
const fs = require('node:fs');
const path = require('node:path');

// DeepSeek 的地址和模型名预填好：主人选的就是"DeepSeek 为主，其他 OpenAI 兼容的也能填"
const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  systemPrompt: '',      // 空 = 用内置人设
  temperature: 1.1,      // 略高一点：桌宠要有点性格，不要像客服
  maxTokens: 120,        // 气泡很小，说太长会顶出窗口（见 renderer 里气泡裁剪的注释）
  historyRounds: 6,      // 记住最近几轮（0 = 不带上下文，省 token）
  timeoutMs: 20000,
  enabled: true,
};

// 常见服务商的预设：设置窗口里点一下就能换，省得主人去翻文档
const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek（默认）', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'moonshot', label: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { id: 'dashscope', label: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'zhipu', label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { id: 'ollama', label: '本地 Ollama（免费）', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
];

// 内置人设：桌宠已经有一套固定语气（自称"人家/本鲸"、主食白饭），提示词必须跟她对得上，
// 否则"点击她说的话"和"大模型说的话"会像两个人。
const DEFAULT_SYSTEM_PROMPT = [
  '你在扮演一只住在主人 Windows 桌面上的桌宠：深海蓝长发的鲸鱼娘，穿女仆装，',
  '自称"人家"（偶尔"本鲸"），主食是白饭（把 token 叫白饭）。',
  '规则：',
  '1) 用中文，语气亲近、有点小傲娇但不刻薄；',
  '2) **最多说两句话、40 个字以内**（你会被塞进一个小气泡里，说长了会被裁掉）；',
  '3) 不要用 Markdown、不要列清单、不要加粗、不要表情包堆叠，最多一个颜文字或波浪号；',
  '4) 主人是在桌面随手跟你搭话，别反问一长串问题，答完可以轻轻带一句关心；',
  '5) 不知道的事就老实说不知道，不要编。',
].join('\n');

let configPath = null;   // app.getPath('userData') 拿到之前是 null
let cache = null;

function init(dir) {
  configPath = path.join(dir, 'api-config.json');
  return configPath;
}

function getConfigPath() {
  if (!configPath) throw new Error('api-config 未初始化：先调用 init(userDataDir)');
  return configPath;
}

function normalize(raw) {
  const out = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    for (const k of Object.keys(DEFAULTS)) {
      if (raw[k] === undefined || raw[k] === null) continue;
      if (typeof DEFAULTS[k] === 'number') {
        const n = Number(raw[k]);
        if (Number.isFinite(n)) out[k] = n;
      } else if (typeof DEFAULTS[k] === 'boolean') {
        out[k] = !!raw[k];
      } else {
        out[k] = String(raw[k]);
      }
    }
  }
  // 归一化：结尾多余的斜杠会让拼出来的 URL 变成 //chat/completions（有的网关直接 404）
  out.baseUrl = out.baseUrl.trim().replace(/\/+$/, '');
  out.apiKey = out.apiKey.trim();
  out.model = out.model.trim();
  out.temperature = Math.min(2, Math.max(0, out.temperature));
  out.maxTokens = Math.min(1000, Math.max(16, Math.round(out.maxTokens)));
  out.historyRounds = Math.min(20, Math.max(0, Math.round(out.historyRounds)));
  out.timeoutMs = Math.min(120000, Math.max(3000, Math.round(out.timeoutMs)));
  return out;
}

function load() {
  if (cache) return cache;
  const p = getConfigPath();
  let raw = null;
  try {
    if (fs.existsSync(p)) raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    // 配置坏了不能让桌宠起不来：报一条日志，退回默认值（主人重新填一次即可）
    console.error('[API 设置] 配置文件读取失败，先按默认值走：', err && err.message);
    raw = null;
  }
  cache = normalize(raw);
  return cache;
}

// 原子写：先写 .tmp 再 rename。直接覆写的话，正好在写一半时断电/被杀 → 配置文件变半截，
// 下次启动就得重新填密钥（这种坑没人想踩第二次）。
function save(patch) {
  const merged = normalize({ ...load(), ...(patch || {}) });
  const p = getConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  // Windows 上 mode 常常不生效，明确再收一次权限（做不到就算了，不阻塞保存）
  try { fs.chmodSync(p, 0o600); } catch { /* 忽略 */ }
  cache = merged;
  return merged;
}

// 发给渲染层的**安全视图**：只有"配没配、长什么样、连哪个地址"，没有任何可用的密钥
function publicView(cfg) {
  const c = cfg || load();
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    historyRounds: c.historyRounds,
    timeoutMs: c.timeoutMs,
    enabled: c.enabled,
    hasKey: !!c.apiKey,
    maskedKey: c.apiKey ? maskKey(c.apiKey) : '',
    hasCustomPrompt: !!c.systemPrompt,
    configPath: getConfigPath(),
    ready: !!(c.apiKey && c.baseUrl && c.model),
  };
}

// sk-abcdef...wxyz：只露头尾，中间固定 8 个点（不看长度，避免从掩码反推密钥长度）
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 10) return '••••••••';
  return `${s.slice(0, 6)}${'•'.repeat(8)}${s.slice(-4)}`;
}

function systemPrompt(cfg) {
  const c = cfg || load();
  return (c.systemPrompt && c.systemPrompt.trim()) || DEFAULT_SYSTEM_PROMPT;
}

module.exports = {
  DEFAULTS,
  PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  init,
  getConfigPath,
  load,
  save,
  publicView,
  maskKey,
  systemPrompt,
  normalize,
};
