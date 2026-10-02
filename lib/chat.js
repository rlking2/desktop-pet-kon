// 大模型对话：主进程直连 OpenAI 兼容接口（DeepSeek / OpenAI / Kimi / 通义 / 智谱 / 本地 Ollama 都能用）
//
// 【为什么这个文件必须跑在主进程】
//   1) 渲染层带着 CSP `default-src 'none'`（见 renderer/index.html），发不出网络请求；
//   2) 更关键的是**密钥安全**：密钥只在这儿用，渲染层永远拿不到（见 lib/api-config.js 的注释）。
//
// 【为什么"失败也要有人话"】
//   桌宠的对话框是主人天天看的地方。要是超时了就弹一句 `TypeError: fetch failed`，
//   这东西立刻从"桌宠"变成"报错框"。所以所有错误都翻译成她自己的口气（ERROR_LINES），
//   同时把技术细节留在 console 和 artifacts 日志里给人看。
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// 失败时的口气：既告诉主人"没连上"，也不像程序在报错
const ERROR_LINES = {
  noKey: '（人家还没拿到钥匙呢…右键「设置…」把 API 密钥填进来吧）',
  auth: '（钥匙不对哦，人家被门口拦下来了）',
  quota: '（白饭吃完了…账户余额或额度得看一下）',
  rate: '（问得太快啦，人家缓一口气再说）',
  notfound: '（找不到那个模型，设置里的模型名可能写错了）',
  timeout: '（想太久啦…网络或者接口超时了）',
  network: '（连不上接口，检查一下网络和 Base URL？）',
  server: '（对面服务器打嗝了，过会儿再问人家）',
  badResponse: '（对面回的话人家看不懂…）',
  empty: '（人家想了半天，什么也没想出来）',
  disabled: '（人家现在没开口的权限…右键「设置…」看看吧）',
};

// 把各种错误翻译成"分类 + 台词"。
// ★ 错误分类是给人看的诊断信息，也是自检的抓手（哪一类失败都要有台词，不许漏）。
function classify(err, status, body) {
  const text = String(body || '');
  if (status === 401 || status === 403) return { kind: 'auth', line: ERROR_LINES.auth };
  if (status === 402) return { kind: 'quota', line: ERROR_LINES.quota };
  if (status === 429) return { kind: 'rate', line: ERROR_LINES.rate };
  if (status === 404) return { kind: 'notfound', line: ERROR_LINES.notfound };
  if (status >= 500) return { kind: 'server', line: ERROR_LINES.server };
  if (err) {
    const code = err.code || '';
    if (code === 'ETIMEDOUT' || err.name === 'AbortError' || /timeout/i.test(err.message || '')) {
      return { kind: 'timeout', line: ERROR_LINES.timeout };
    }
    if (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'EAI_AGAIN') {
      return { kind: 'network', line: ERROR_LINES.network };
    }
    return { kind: 'network', line: ERROR_LINES.network, detail: err.message };
  }
  if (status && status >= 400) return { kind: 'badResponse', line: ERROR_LINES.badResponse, detail: `HTTP ${status}: ${text.slice(0, 200)}` };
  return { kind: 'badResponse', line: ERROR_LINES.badResponse, detail: text.slice(0, 200) };
}

function endpointOf(baseUrl) {
  // 允许主人填 "https://api.deepseek.com" 或 ".../v1" 或直接填到 ".../chat/completions"
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

// 发一次请求。resolve 形如 { ok, status, text, json }：**网络层错误也 resolve**，
// 由调用方决定怎么翻译（这样超时/拒绝连接/HTTP 错误能走同一条诊断路径）。
function postJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      resolve({ ok: false, status: 0, text: `URL 不合法：${url}`, err });
      return;
    }
    const mod = target.protocol === 'http:' ? http : https;
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'http:' ? 80 : 443),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Accept: 'application/json',
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 不是 JSON 就留 null，交给上层报"看不懂" */ }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, json });
      });
    });
    // 超时必须自己设：Node 的 request 默认无限等，主人在屏幕前会以为桌宠死了
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`请求超时（${timeoutMs}ms）`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (err) => resolve({ ok: false, status: 0, text: '', err }));
    req.write(payload);
    req.end();
  });
}

// 从各家五花八门的返回里把正文抠出来（有的走 choices[0].message.content，有的走 choices[0].text）
function extractText(json) {
  if (!json) return '';
  const ch = json.choices && json.choices[0];
  if (!ch) return '';
  const msg = ch.message || {};
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) text = msg.content.map((p) => (p && (p.text || '')) || '').join('');
  else if (typeof ch.text === 'string') text = ch.text;
  return String(text || '').trim();
}

// 气泡很小（192px 宽），说太长会顶出窗口；而且有的模型爱加 Markdown/引号，统一清一遍
function tidy(text, maxChars = 60) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, '')          // 代码块直接丢（气泡里没法看）
    .replace(/[*_`#>]/g, '')                  // Markdown 记号
    .replace(/^\s*[-•]\s*/gm, '')             // 列表符号
    .replace(/\s*\n+\s*/g, ' ')               // 换行压成空格，气泡不换行更整齐
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')     // 首尾引号
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > maxChars) s = s.slice(0, maxChars - 1) + '…';
  return s;
}

// 单轮对话：messages = [{role:'system'|'user'|'assistant', content}]
// 返回统一结构，**永不 throw**：调用方永远拿到 { ok, text, kind }，界面永远不会看到原始异常。
async function chat(cfg, messages) {
  if (!cfg) return { ok: false, kind: 'disabled', text: ERROR_LINES.disabled };
  if (!cfg.enabled) return { ok: false, kind: 'disabled', text: ERROR_LINES.disabled };
  if (!cfg.apiKey) return { ok: false, kind: 'noKey', text: ERROR_LINES.noKey };
  if (!cfg.baseUrl || !cfg.model) {
    return { ok: false, kind: 'badResponse', text: '（Base URL 或模型名还没填哦）' };
  }

  const url = endpointOf(cfg.baseUrl);
  const started = Date.now();

  // 自检专用旁路：把回话换成一个假的，但**后面的每一步都照跑**（extractText / tidy / 返回结构）。
  // 这样"她从模型拿话"这条路能在离线、无密钥的前提下被断言验证 —— 见 api-config.js 里 mockReply 的注释。
  // 正常运行时 cfg.mockReply 永远是空串，这里根本不会进来。
  if (cfg.mockReply) {
    const rawMock = String(cfg.mockReply);
    return {
      ok: true,
      kind: 'ok',
      raw: rawMock,
      text: tidy(rawMock, 60),
      model: cfg.model,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, mocked: true },
      ms: Date.now() - started,
      mocked: true,
    };
  }

  const res = await postJson(url, {
    headers: { Authorization: `Bearer ${cfg.apiKey}` },
    body: {
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: false,
    },
    timeoutMs: cfg.timeoutMs,
  });
  const ms = Date.now() - started;

  if (!res.ok || !res.json) {
    const c = classify(res.err, res.status, res.text || (res.err && res.err.message));
    return { ok: false, kind: c.kind, text: c.line, detail: c.detail, status: res.status, ms };
  }
  // 有的网关 HTTP 200 但 body 里塞 error（代理层的老毛病），也要当失败处理
  if (res.json.error) {
    const c = classify(null, 0, JSON.stringify(res.json.error).slice(0, 200));
    return { ok: false, kind: 'badResponse', text: c.line, detail: c.detail, status: res.status, ms };
  }
  const raw = extractText(res.json);
  if (!raw) return { ok: false, kind: 'empty', text: ERROR_LINES.empty, status: res.status, ms };

  return {
    ok: true,
    kind: 'ok',
    raw,
    text: tidy(raw, 60),
    model: res.json.model || cfg.model,
    usage: res.json.usage || null,
    ms,
  };
}

// 设置窗口的"测试连接"：发一句最短的话，把结果（含 HTTP 状态与真实延迟）报回去。
// 它和正式对话共用同一条代码路径 —— 测试绿了、正式用却红，是那种最费时间的 bug。
async function testConnection(cfg) {
  const res = await chat(cfg, [
    { role: 'system', content: '你是一只桌面桌宠，用中文回答，不超过 10 个字。' },
    { role: 'user', content: '在吗？' },
  ]);
  return res;
}

module.exports = { chat, testConnection, tidy, extractText, classify, endpointOf, ERROR_LINES };
