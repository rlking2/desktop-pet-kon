// 素材清单（主进程侧）：在主进程里读磁盘并把清单交给渲染层。
//
// 为什么不直接在渲染层 fetch('assets/manifest.json')？
//   渲染层的 CSP 是 default-src 'none'（只放行 'self' 的 script/style），fetch 会被拦。
//   而主进程有完整 Node 权限，扫目录 + 读 json 最省事，也不需要在 CSP 上开口子。
//
// 约定：优先读 assets/manifest.json（由 scripts/inspect-assets.js --write 生成）；
//       不存在则返回 null，渲染层自动退回内置的 SVG 占位形象（零配置）。
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function loadAnimationManifest(assetsDir) {
  const manifestPath = path.join(assetsDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return { found: false, reason: 'assets/manifest.json 不存在' };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return { found: false, reason: `manifest.json 解析失败: ${err.message}` };
  }

  // 兼容两种结构：
  //   A) 单组：{ group, canvas, frames:[{file,delayMs}] }
  //   B) 多组：{ groups: { idle: {...}, hop: {...} } }
  const groupsIn = raw.groups && typeof raw.groups === 'object' ? raw.groups : { [raw.group || 'idle']: raw };
  const out = { found: true, source: path.relative(process.cwd(), manifestPath), groups: {}, problems: [] };

  for (const [name, g] of Object.entries(groupsIn)) {
    if (!g || !Array.isArray(g.frames) || !g.frames.length) {
      out.problems.push(`动作「${name}」没有可用帧`);
      continue;
    }
    const baseDir = g.frames[0].file.includes('/') || g.frames[0].file.includes('\\')
      ? path.dirname(path.join(assetsDir, g.frames[0].file))
      : assetsDir;
    const frames = [];
    for (const f of g.frames) {
      const abs = path.isAbsolute(f.file) ? f.file : path.join(assetsDir, f.file);
      if (!fs.existsSync(abs)) { out.problems.push(`动作「${name}」缺帧文件: ${f.file}`); continue; }
      // 部件描边掩码（可选）：和帧同名，放在 build/edges/<组>/ 下。
      // 由 scripts/make-edge-masks.js 生成（头发/眉毛/手/裙子外层/腿脚的轮廓线）。
      const sep = path.sep;
      const edgeAbs = abs.includes(`${sep}frames${sep}`) ? abs.replace(`${sep}frames${sep}`, `${sep}edges${sep}`) : null;
      const edgeUrl = (edgeAbs && fs.existsSync(edgeAbs)) ? pathToFileURL(edgeAbs).href : null;
      frames.push({ url: pathToFileURL(abs).href, edgeUrl, delayMs: Math.max(16, Number(f.delayMs) || 120) });
    }
    if (!frames.length) { out.problems.push(`动作「${name}」全部帧文件缺失`); continue; }
    out.groups[name] = {
      name,
      canvas: g.canvas || null,
      frameCount: frames.length,
      totalMs: frames.reduce((s, f) => s + f.delayMs, 0),
      frames,
      baseDir: path.relative(process.cwd(), baseDir),
    };
  }

  out.ok = Object.keys(out.groups).length > 0;
  if (!out.ok) out.found = false;
  return out;
}

module.exports = { loadAnimationManifest };
