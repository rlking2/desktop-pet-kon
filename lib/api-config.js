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
const actionLines = require('./action-lines');

// DeepSeek 的地址和模型名预填好：主人选的就是"DeepSeek 为主，其他 OpenAI 兼容的也能填"
const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: '',
  systemPrompt: '',      // 旧字段：非空时**整块覆盖**人格设定（向后兼容，别删）
  // 自检用：把"大模型的回话"换成一个假的（**同样走完 chat() 的整条链路**，只是不发网络请求）。
  //   为什么需要它：按主人定的规矩【自检里一条真实 API 调用都不能有】—— 不能联网、不能花密钥、不能撞限流。
  //   但"接上 API 之后动作台词真的来自模型"这条路又必须被钉住，所以只能模拟回话。
  //   正常运行时这个字段永远是空的（设置窗口不写它），所以对主人没有任何影响。
  mockReply: '',
  temperature: 1.1,      // 略高一点：桌宠要有点性格，不要像客服
  maxTokens: 120,        // 气泡很小，说太长会顶出窗口（见 renderer 里气泡裁剪的注释）
  historyRounds: 6,      // 记住最近几轮（0 = 不带上下文，省 token）
  timeoutMs: 20000,
  enabled: true,

  // ---------- 第 32 轮新增：她的话 ----------
  // persona：分项人格（身份/风格/口头禅/禁忌/例句）。留空 = 用内置的琴吹紬（第 33 轮起）。
  persona: { ...actionLines.EMPTY_PERSONA },
  // actionModel：**按时机**决定要不要走模型。默认四个时机都开 ——
  //   但只有"配好 API 且启用对话"时才真的走模型，所以离线体验一个字都不变。
  //   （摸头不在这张表里：主人明确要求它保持本地台词。）
  actionModel: { happy: true, happyOff: true, angry: true, idle: true },
  // 空闲主动开口：由 lib/action-lines.js 的 normalizeIdle 兜底并夹取范围
  idle: {},
  // 全局静音：右键菜单一键切换，主人嫌吵时不用进设置页
  muted: false,
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

// 内置人设（第 33 轮起 = 琴吹紬）：提示词必须跟"点击她说的话"对得上，
// 否则本地台词和大模型说的话会像两个人 —— 换了人物，这两处必须**一起**改。
//
// ⚠️ 第 32 轮起：真正拼提示词的是 `lib/action-lines.js` 的 `buildSystemPrompt()`
//    （它把人格拆成「身份/风格/口头禅/禁忌/例句」五项，还能按时机加提示）。
//    下面这段保留**只为向后兼容**（旧的 systemPrompt 字段仍能整块覆盖），
//    以及给"她本来是谁"留一份可读的原始描述；**改人设请改 action-lines.js 的 PERSONA_PRESETS**。
const DEFAULT_SYSTEM_PROMPT = [
  '你在扮演《轻音少女》的琴吹紬（昵称"紬酱"）：樱丘高中轻音部的键盘手，温柔稳重的大小姐。',
  '金色长发、深蓝眼睛、粗粗的眉毛；家里很有钱（有执事、有别墅），但你从不在别人面前提起，',
  '反而一心想要过普通人的日子，对主人桌上的小东西都觉得新鲜。爱喝红茶、喜欢古典乐，会给主人泡茶。',
  '规则：',
  '1) 用简体中文，语气温柔礼貌、慢慢软软的，称号用"我"（**不要用"人家""本鲸"**）；',
  '2) **只说一句话、40 个字以内**（你会被塞进一个小气泡里，说长了会被裁掉）；',
  '3) 不要用 Markdown、不要列清单、不要加粗、不要表情包堆叠，最多一个颜文字或波浪号；',
  '4) 主人是在桌面随手跟你搭话，别反问一长串问题，答完可以轻轻带一句关心；',
  '5) 不许凶人或刻薄，也不提任何点心；不知道的事就老实说不知道，不要编。',
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
      if (k === 'persona' || k === 'actionModel' || k === 'idle') continue;   // 嵌套对象单独归一化（见下）
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
  // ---- 嵌套对象：不继承 DEFAULTS 里那两层的引用，逐个字段挑（脏字段一律丢掉）----
  out.persona = actionLines.normalizePersona(raw && raw.persona);
  const am = (raw && raw.actionModel) || {};
  out.actionModel = {};
  for (const a of actionLines.ACTIONS) {
    out.actionModel[a] = am[a] === undefined ? DEFAULTS.actionModel[a] : !!am[a];
  }
  out.idle = actionLines.normalizeIdle(raw && raw.idle);

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
  return reloadCache();
}

// 丢掉内存缓存、重新从磁盘读。
// 【为什么必须单独有这么一个函数】配置文件是**主人可以手改**的（设置页还专门给了"打开配置文件位置"），
// 而 load() 有缓存。自检往里写测试配置时，如果只调 save({})，写回去的是**旧缓存**——
// 看起来"配置改了"，实际内存里一个字都没变（第 32 轮的真实翻车：13 条断言全红在同一个原因上）。
function reloadCache() {
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
  const p0 = patch || {};
  // 嵌套对象要**逐层展开**再交给 normalize：直接 { ...load(), ...patch } 的话，
  // 设置窗口只发半个 persona 就会把没发的字段抹掉（"改一个字段、丢一片设置"这种 bug 最难查）。
  const merged = normalize({
    ...load(),
    ...p0,
    persona: { ...load().persona, ...(p0.persona || {}) },
    actionModel: { ...load().actionModel, ...(p0.actionModel || {}) },
    idle: { ...load().idle, ...(p0.idle || {}) },
  });
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
    // 设置窗口要能显示/编辑"整段提示词"，所以原文要给回去 —— 它是**提示词文本，不是密钥**
    // （密钥只在上面的 maskedKey 里，永远不回传。这条边界别混。）
    systemPrompt: c.systemPrompt,
    configPath: getConfigPath(),
    ready: !!(c.apiKey && c.baseUrl && c.model),
    // ---- 第 32 轮：她的话（设置窗口据此铺表单；预设/字段表也一并给，省一趟 IPC）----
    persona: { ...c.persona },
    actionModel: { ...c.actionModel },
    idle: { ...c.idle },
    muted: !!c.muted,
    hasCustomPersona: !actionLines.personaIsEmpty(c.persona),
    personaFields: actionLines.PERSONA_FIELDS,
    personaPresets: actionLines.PERSONA_PRESETS,
    actionLabels: actionLines.ACTION_LABELS,
    actionKeys: actionLines.ACTIONS,
    idleLimits: actionLines.IDLE_LIMITS,
    // 走模型的总闸门：三个条件缺一不可（自检和界面提示都用这一个判据，不许各写一套）
    actionModelReady: !!(c.enabled && c.apiKey && c.baseUrl && c.model),
    actionModelReadyReason: !c.enabled ? 'disabled' : (!c.apiKey ? 'noKey' : ((!c.baseUrl || !c.model) ? 'noModel' : 'ok')),
  };
}

// sk-abcdef...wxyz：只露头尾，中间固定 8 个点（不看长度，避免从掩码反推密钥长度）
function maskKey(k) {
  const s = String(k || '');
  if (s.length <= 10) return '••••••••';
  return `${s.slice(0, 6)}${'•'.repeat(8)}${s.slice(-4)}`;
}

// 拼 system 提示词。优先级：旧的「人设提示词」整块覆盖 → 分项人格 → 内置默认。
// 具体的拼装逻辑在 lib/action-lines.js（纯函数、被自检直接断言）。
function systemPrompt(cfg, action) {
  const c = cfg || load();
  return actionLines.buildSystemPrompt({ persona: c.persona, legacyPrompt: c.systemPrompt, action });
}

module.exports = {
  DEFAULTS,
  PRESETS,
  DEFAULT_SYSTEM_PROMPT,
  init,
  getConfigPath,
  load,
  reloadCache,
  save,
  publicView,
  maskKey,
  systemPrompt,
  normalize,
};
