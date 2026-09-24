// 自动抠图：针对"纯色/条纹背景"的素材（主人这批图就是粉白条纹 + 一圈描边）。
//
// 算法（不靠眼睛，全靠统计）：
//   1) 从四边采样，统计出背景由哪几种颜色构成（这批图是 粉 + 白 两条纹 + 青色描边）
//   2) 每个像素若"离任一背景色足够近" → 置为透明
//   3) 从四边做连通域扩散，只删除与边缘连通的背景（避免把人物身上同色的部分挖洞）
//   4) 边缘 alpha 羽化（按距离给中间值），避免锯齿
//   5) 裁掉四周空白、缩放到目标尺寸
//
// 用法:
//   node scripts/cutout.js                     # 处理 assets/ 下所有图，输出到 assets/cutout/
//   node scripts/cutout.js assets/1.png        # 只处理一张
//   node scripts/cutout.js --tol=40 --size=130 # 调容差与目标尺寸
//   node scripts/cutout.js --preview           # 只输出分析报告，不写文件
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const OUTDIR = path.join(ASSETS, 'cutout');

// ---------------- 参数 ----------------
const args = process.argv.slice(2);
const opt = { tol: 34, size: 130, feather: 1, preview: false, debug: false, files: [] };
for (const a of args) {
  if (a === '--preview') opt.preview = true;
  else if (a === '--debug') opt.debug = true;
  else if (a.startsWith('--tol=')) opt.tol = Number(a.split('=')[1]);
  else if (a.startsWith('--size=')) opt.size = Number(a.split('=')[1]);
  else if (a.startsWith('--feather=')) opt.feather = Number(a.split('=')[1]);
  else opt.files.push(a);
}

// ---------------- PNG 解码 ----------------
function decodePNG(buf) {
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('隔行 PNG 暂不支持');
      if (bitDepth !== 8) throw new Error(bitDepth + 'bit PNG 暂不支持');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    prev = line;
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels >= 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; }
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, rgba: out, hasAlpha: colorType === 4 || colorType === 6 };
}

// ---------------- PNG 编码 ----------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------- 背景色统计 ----------------
function findBackgroundColors(img, opt2) {
  const { width: W, height: H, rgba } = img;
  const at = (x, y) => { const i = (y * W + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  // 采样两类位置：
  //  a) 内缩 8%（条纹主体区域）
  //  b) 最外圈 1.5%（描边/边框/角落标签 —— 这批图最外圈是青色描边、角落还有品红标签，
  //     只采内圈会把它们漏成"主体"，导致裁切裁不紧）
  const insetX = Math.max(3, Math.round(W * 0.08));
  const insetY = Math.max(3, Math.round(H * 0.08));
  const ringX = Math.max(1, Math.round(W * 0.015));
  const ringY = Math.max(1, Math.round(H * 0.015));
  const samples = [];
  const stepX = Math.max(1, Math.floor(W / 80));
  const stepY = Math.max(1, Math.floor(H / 80));
  for (let x = insetX; x < W - insetX; x += stepX) { samples.push(at(x, insetY)); samples.push(at(x, H - 1 - insetY)); }
  for (let y = insetY; y < H - insetY; y += stepY) { samples.push(at(insetX, y)); samples.push(at(W - 1 - insetX, y)); }
  // 外圈密采（每 2px 一个点），确保描边色被抓到
  for (let x = 0; x < W; x += 2) { samples.push(at(x, ringY)); samples.push(at(x, H - 1 - ringY)); }
  for (let y = 0; y < H; y += 2) { samples.push(at(ringX, y)); samples.push(at(W - 1 - ringX, y)); }
  // 聚类（简单贪心，阈值 24）
  const clusters = [];
  for (const c of samples) {
    let hit = null;
    for (const cl of clusters) {
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(c[k] - cl.mean[k])));
      if (d <= 24) { hit = cl; break; }
    }
    if (hit) {
      hit.count++;
      for (let k = 0; k < 3; k++) hit.mean[k] = (hit.mean[k] * (hit.count - 1) + c[k]) / hit.count;
    } else clusters.push({ mean: c.slice(), count: 1 });
  }
  clusters.sort((a, b) => b.count - a.count);
  const totalSamples = samples.length;
  const picked = clusters.filter((c) => c.count / totalSamples > 0.02)
    .map((c) => ({ rgb: c.mean.map((v) => Math.round(v)), pct: +(c.count / totalSamples * 100).toFixed(1) }));

  // ★ 最外圈逐像素采样：图像最外 1~2 像素**必然是背景**（描边/边框/留白/模糊过渡），
  //   只按"占比筛"会漏掉它，漏掉的后果是裁切裁不紧（实测 505x774 原尺寸原样输出）。
  //
  //   ⚠️ 踩坑记录：一开始用 Map 按**精确 RGB 值**统计外圈颜色 —— 但描边是**带噪点**的
  //   （24,25,21 / 23,24,22 / 25,24,25 各不相同），于是最"标准"的那个值只占 12.7%，
  //   被 25% 阈值卡掉，整条描边都判不出来。必须**按容差聚类**，不能按精确值。
  const outerSamples = [];
  for (let x = 0; x < W; x++) {
    for (const y of [0, 1, H - 1, H - 2]) if (y >= 0 && y < H) outerSamples.push(at(x, y));
  }
  for (let y = 0; y < H; y++) {
    for (const x of [0, 1, W - 1, W - 2]) if (x >= 0 && x < W) outerSamples.push(at(x, y));
  }
  const outerClusters = [];
  for (const c of outerSamples) {
    let hit = null;
    for (const cl of outerClusters) {
      const d = Math.max(...[0, 1, 2].map((k) => Math.abs(c[k] - cl.mean[k])));
      if (d <= 20) { hit = cl; break; }
    }
    if (hit) {
      hit.count++;
      for (let k = 0; k < 3; k++) hit.mean[k] = (hit.mean[k] * (hit.count - 1) + c[k]) / hit.count;
    } else outerClusters.push({ mean: c.slice(), count: 1 });
  }
  outerClusters.sort((a, b) => b.count - a.count);
  const outerCount = outerSamples.length;
  let outerAdded = 0;
  for (const c of outerClusters) {
    // 外圈里占比超过 15% 的簇才算"描边/边框主色"
    if (c.count / outerCount < 0.15) continue;
    const rgb = c.mean.map((v) => Math.round(v));
    const dup = picked.some((p) => Math.max(...[0, 1, 2].map((k) => Math.abs(p.rgb[k] - rgb[k]))) <= 24);
    if (!dup) { picked.push({ rgb, pct: +(c.count / outerCount * 100).toFixed(1), fromBorder: true }); outerAdded++; }
  }

  const topOuter = outerClusters.slice(0, 4)
    .map((c) => ({ rgb: c.mean.map((v) => Math.round(v)), pct: +(c.count / outerCount * 100).toFixed(1) }));
  return { colors: picked, totalSamples, outerAdded, outerSampleCount: outerCount, outerTop: topOuter, outerClusters: outerClusters.length };
}

// ---------------- 抠图主体 ----------------
function cutout(img, bg, opt2) {
  const { width: W, height: H, rgba } = img;
  const { tol } = opt2;
  const colors = bg.colors.map((c) => c.rgb);
  // 双层阈值：紧贴背景（<=tol）算"确定背景"；tol~tol*1.8 之间算"过渡带"（柔边/防锯齿）。
  // 过渡带只在"紧邻已确定的背景"时才允许一起删掉——这样能吃掉描边与画面之间的模糊带
  // （实测那一段是 rgb(92,42,54) 这种中间色，只按 tol 判会留下 1~2px 残边导致裁不紧），
  // 又不会误删主体内部恰好是中间色的像素。
  const tolOuter = Math.round(tol * 1.8);

  // 1) 标记"像背景色"的像素（确定 / 过渡）
  const bgLike = new Uint8Array(W * H);       // 1=确定背景, 2=过渡带
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      let best = Infinity;
      for (const c of colors) {
        const d = Math.max(Math.abs(r - c[0]), Math.abs(g - c[1]), Math.abs(b - c[2]));
        if (d < best) best = d;
      }
      if (best <= tol) bgLike[y * W + x] = 1;
      else if (best <= tolOuter) bgLike[y * W + x] = 2;
    }
  }

  // 2) 从四边做连通域扩散 —— 只删"与边缘连通"的背景，
  //    这样人物身上恰好同色的部分不会被挖洞。
  //    规则：确定背景可以直接扩散；过渡带像素只有在"旁边已经确定背景/过渡带"时才被吞掉。
  //
  //    ⚠️ 踩坑记录：第一版用普通数组当栈 + "已访问"判断写在 bgMask 上，
  //    结果过渡带像素会被反复入栈（bgMask 一直等于 2，永远不满足 continue 条件），
  //    数组无限膨胀 → RangeError: Invalid array length。改用 typed array + done 标记。
  const bgMask = new Uint8Array(W * H);
  const done = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let sp = 0;
  const push = (x, y) => { if (sp < stack.length) stack[sp++] = y * W + x; };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); }
  for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (sp > 0) {
    const idx = stack[--sp];
    if (done[idx]) continue;
    const like = bgLike[idx];
    if (like === 0) continue;                 // 明显是主体
    if (like === 2) {
      // 过渡带：邻居里要有已确认的背景/过渡带才吞
      const x = idx % W, y = (idx - x) / W;
      let nb = false;
      if (x > 0 && bgMask[idx - 1]) nb = true;
      if (!nb && x < W - 1 && bgMask[idx + 1]) nb = true;
      if (!nb && y > 0 && bgMask[idx - W]) nb = true;
      if (!nb && y < H - 1 && bgMask[idx + W]) nb = true;
      if (!nb) continue;
    }
    done[idx] = 1;
    bgMask[idx] = like;
    const x = idx % W, y = (idx - x) / W;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  // 3) 生成带 alpha 的结果
  const out = Buffer.from(rgba);
  let removed = 0;
  for (let i = 0; i < W * H; i++) {
    if (bgMask[i] === 1) { out[i * 4 + 3] = 0; removed++; }
    else if (bgMask[i] === 2) { out[i * 4 + 3] = 40; removed++; } // 过渡带留一点羽化
  }

  // 4) 兜底：最外圈若还残留**极少量**不透明像素，直接清掉。
  //    这类残边通常是描边与画面之间的抗锯齿像素（实测 1.png 只剩 1 个在 (420,773)），
  //    留着会让裁切裁不紧（输出仍是整幅原图尺寸）。
  //    数量限制在 2% 周长以内 —— 只有在"几乎已经清干净"时才启用，避免误吞主体贴边的情况。
  {
    const edgeIdx = [];
    for (let x = 0; x < W; x++) { edgeIdx.push(x); edgeIdx.push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { edgeIdx.push(y * W); edgeIdx.push(y * W + W - 1); }
    let leftover = 0;
    for (const idx of edgeIdx) if (out[idx * 4 + 3] > 8) leftover++;
    const limit = Math.max(12, Math.round((W + H) * 0.02));
    if (leftover > 0 && leftover <= limit) {
      for (const idx of edgeIdx) out[idx * 4 + 3] = 0;
      removed += leftover;
    }
  }

  // 5) 边缘羽化：把"紧邻透明区"的不透明像素 alpha 压低一点，减少锯齿
  if (opt2.feather > 0) {
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const idx = y * W + x;
        if (bgMask[idx]) continue;
        let n = 0;
        if (bgMask[idx - 1]) n++;
        if (bgMask[idx + 1]) n++;
        if (bgMask[idx - W]) n++;
        if (bgMask[idx + W]) n++;
        if (n > 0) out[idx * 4 + 3] = Math.max(60, 255 - n * 55);
      }
    }
  }

  return { rgba: out, removed, removedPct: +(removed / (W * H) * 100).toFixed(1) };
}

// ---------------- 裁剪 + 缩放 ----------------
function trimAndScale(rgba, W, H, targetSize) {
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (rgba[(y * W + x) * 4 + 3] > 8) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { rgba: Buffer.alloc(targetSize * targetSize * 4), w: targetSize, h: targetSize, trimmed: null };
  // 留 4px 边距
  const pad = 4;
  minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
  maxX = Math.min(W - 1, maxX + pad); maxY = Math.min(H - 1, maxY + pad);
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  // 等比缩放到 targetSize（最长边）
  const scale = targetSize / Math.max(cw, ch);
  const tw = Math.max(1, Math.round(cw * scale)), th = Math.max(1, Math.round(ch * scale));
  const dst = Buffer.alloc(tw * th * 4);
  // 面积平均（比最近邻好，缩小时不闪）
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx0 = minX + Math.floor(x / scale), sx1 = Math.min(maxX, minX + Math.ceil((x + 1) / scale) - 1);
      const sy0 = minY + Math.floor(y / scale), sy1 = Math.min(maxY, minY + Math.ceil((y + 1) / scale) - 1);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy <= sy1; sy++) {
        for (let sx = sx0; sx <= sx1; sx++) {
          const i = (sy * W + sx) * 4;
          const av = rgba[i + 3] / 255;
          r += rgba[i] * av; g += rgba[i + 1] * av; b += rgba[i + 2] * av; a += rgba[i + 3];
          n++;
        }
      }
      const di = (y * tw + x) * 4;
      const aAvg = a / n;
      const wsum = aAvg > 0 ? aAvg / 255 * n : 1;
      dst[di] = Math.round(r / wsum); dst[di + 1] = Math.round(g / wsum); dst[di + 2] = Math.round(b / wsum);
      dst[di + 3] = Math.round(aAvg);
    }
  }
  return { rgba: dst, w: tw, h: th, trimmed: { x: minX, y: minY, w: cw, h: ch } };
}

// ---------------- 主流程 ----------------
function listPngs() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === 'cutout' || e.name === 'build' || e.name.startsWith('_')) continue;
        walk(path.join(dir, e.name));
        continue;
      }
      const full = path.join(dir, e.name);
      try {
        const fd = fs.openSync(full, 'r'); const h = Buffer.alloc(4); fs.readSync(fd, h, 0, 4, 0); fs.closeSync(fd);
        if (h[0] === 0x89 && h[1] === 0x50) out.push(full);
      } catch { /* 跳过 */ }
    }
  })(ASSETS);
  return out.sort();
}

const files = opt.files.length
  ? opt.files.map((f) => path.resolve(f))
  : listPngs();

if (!files.length) {
  console.log('没有找到可处理的 PNG。把图放进 assets/ 即可。');
  process.exit(0);
}
if (!opt.preview) fs.mkdirSync(OUTDIR, { recursive: true });

console.log(`自动抠图（容差 ${opt.tol}，目标尺寸 ${opt.size}px）\n`);
let okCount = 0;
const report = [];
for (const f of files) {
  const rel = path.relative(ROOT, f);
  let img;
  try { img = decodePNG(fs.readFileSync(f)); }
  catch (err) { console.log(`❌ ${rel}  解码失败: ${err.message}`); continue; }

  const bg = findBackgroundColors(img, opt);
  const res = cutout(img, bg, opt);
  const scaled = trimAndScale(res.rgba, img.width, img.height, opt.size);
  if (opt.debug) {
    const at = (x, y) => { const i = (y * img.width + x) * 4; return `${rgba[i]},${rgba[i+1]},${rgba[i+2]}`; };
    const { rgba } = img;
    console.log(`  [调试] 外圈新增背景色 ${bg.outerAdded} 种；外圈采样数=${bg.outerSampleCount} 外圈主色=${JSON.stringify(bg.outerTop)}`);
    console.log(`  [调试] 最终背景色: ${bg.colors.map((c) => `rgb(${c.rgb.join(',')})${c.fromBorder ? '(来自外圈)' : ''}`).join('  ')}`);
  }

  // 判断抠图效果（不靠眼睛，靠数据）
  const warnings = [];
  if (bg.colors.length > 3) warnings.push(`背景色有 ${bg.colors.length} 种（可能不是纯色背景，效果难保证）`);
  if (res.removedPct < 20) warnings.push(`只删掉 ${res.removedPct}% 像素，可能没抠干净（背景占比通常 >30%）`);
  if (res.removedPct > 92) warnings.push(`删掉 ${res.removedPct}% 像素，可能把人物也啃掉了（容差偏大？）`);
  const subjectPct = 100 - res.removedPct;

  console.log(`${path.basename(f)}  ${img.width}x${img.height}`);
  console.log(`  背景色: ${bg.colors.map((c) => `rgb(${c.rgb.join(',')}) ${c.pct}%`).join('   ')}`);
  console.log(`  删除像素: ${res.removedPct}%   保留主体: ${subjectPct}%   裁切后: ${scaled.trimmed ? `${scaled.trimmed.w}x${scaled.trimmed.h}` : '空'}   输出: ${scaled.w}x${scaled.h}`);
  if (warnings.length) warnings.forEach((w) => console.log(`  ⚠️ ${w}`));
  else okCount++;

  // 诊断：裁切裁不紧时，报告"边缘还剩哪些不透明像素"
  if (opt.preview && scaled.trimmed && (scaled.trimmed.w >= img.width - 2 || scaled.trimmed.h >= img.height - 2)) {
    const { width: W2, height: H2 } = img;
    const alphaAt = (x, y) => res.rgba[(y * W2 + x) * 4 + 3];
    const colorAt = (x, y) => { const i = (y * W2 + x) * 4; return `rgb(${res.rgba[i]},${res.rgba[i + 1]},${res.rgba[i + 2]})`; };
    const edges = [];
    const scan = (name, get) => {
      const hits = [];
      for (let k = 0; k < 4; k++) {
        const [x, y] = get(k, k === 0 ? 0 : k === 1 ? W2 - 1 : k === 2 ? W2 >> 1 : W2 >> 2, k === 3 ? H2 - 1 : 0);
        if (alphaAt(x, y) > 8) hits.push(`(${x},${y})=${colorAt(x, y)}`);
      }
      if (hits.length) edges.push(`${name}: ${hits.join(' ')}`);
    };
    // 直接扫四条边（每 60px 一个点），找出还"不透明"的位置
    const leftover = [];
    const probe = (x, y) => { if (alphaAt(x, y) > 8) leftover.push(`(${x},${y})=${colorAt(x, y)}`); };
    for (let x = 0; x < W2; x += 60) { probe(x, 0); probe(x, 1); probe(x, H2 - 1); probe(x, H2 - 2); }
    for (let y = 0; y < H2; y += 60) { probe(0, y); probe(1, y); probe(W2 - 1, y); probe(W2 - 2, y); }
    console.log(`  诊断·边缘残留不透明像素（${leftover.length} 处）: ${leftover.slice(0, 12).join(' ')}${leftover.length > 12 ? ' ...' : ''}`);
    if (edges.length) console.log(`  ${edges.join('  ')}`);
  }
  console.log('');
  if (!opt.preview) {
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    const outPath = path.join(OUTDIR, `${base}.png`);
    fs.writeFileSync(outPath, encodePNG(scaled.w, scaled.h, scaled.rgba));
    console.log(`  → ${path.relative(ROOT, outPath)}`);
  }
  report.push({ file: path.basename(f), bgColors: bg.colors.length, removedPct: res.removedPct, out: `${scaled.w}x${scaled.h}`, warnings });
}

console.log(`\n完成：${files.length} 张，其中 ${okCount} 张无告警${opt.preview ? '（--preview 模式，未写文件）' : `，输出目录 assets/cutout/`}`);
if (!opt.preview) {
  console.log('\n下一步：把想用的那张覆盖成单帧形象跑体检');
  console.log('  copy assets\\cutout\\1.png assets\\idle\\  （或直接当精灵图用）');
  console.log('  npm run assets:write');
}
