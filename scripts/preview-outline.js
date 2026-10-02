// 描边效果离线预览（给 renderer 里的描边参数调参用）
//
// 为什么要有这个：改一次描边参数就要跑一遍 Electron 自检（40 秒）才能看到效果，太慢。
// 这个脚本在 Node 里复现 renderer 的那两步（外轮廓 + 内部边线），直接出图，几秒钟一轮。
//
// 用法:
//   node scripts/preview-outline.js <成品帧.png> [--step=40] [--min-area=60] [--width=1] [--inner=0|1]
//
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = { file: null, mode: 'parts', step: 40, minArea: 40, blur: 1, thresh: 120, tol: 70, contrast: 110,
  excludeStripes: true, width: 1, inner: true, out: null, zoom: 3 };
for (const a of args) {
  if (a.startsWith('--mode=')) opt.mode = a.slice('--mode='.length);
  else if (a.startsWith('--tol=')) opt.tol = Number(a.slice('--tol='.length));
  else if (a.startsWith('--contrast=')) opt.contrast = Number(a.slice('--contrast='.length));
  else if (a.startsWith('--stripes=')) opt.excludeStripes = a.slice('--stripes='.length) !== '0';
  else if (a.startsWith('--thresh=')) opt.thresh = Number(a.slice('--thresh='.length));
  else if (a.startsWith('--blur=')) opt.blur = Number(a.slice('--blur='.length));
  else if (a.startsWith('--min-area=')) opt.minArea = Number(a.slice('--min-area='.length));
  else if (a.startsWith('--width=')) opt.width = Number(a.slice('--width='.length));
  else if (a.startsWith('--inner=')) opt.inner = a.slice('--inner='.length) !== '0';
  else if (a.startsWith('--out=')) opt.out = a.slice('--out='.length);
  else if (a.startsWith('--zoom=')) opt.zoom = Number(a.slice('--zoom='.length));
  else if (!a.startsWith('--')) opt.file = a;
}
if (!opt.file) { console.error('用法: node scripts/preview-outline.js <成品帧.png> [--step=40] [--min-area=60] [--width=1]'); process.exit(2); }
const SRC = path.resolve(ROOT, opt.file);

function decodePNG(buf) {
  let pos = 8, W = 0, H = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const t = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * ch;
  const out = Buffer.alloc(W * H * 4);
  let prev = Buffer.alloc(stride), rp = 0;
  for (let y = 0; y < H; y++) {
    const f = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
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
    for (let x = 0; x < W; x++) {
      const s = x * ch, d = (y * W + x) * 4;
      if (ch === 4) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]; }
      else if (ch === 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
      else if (ch === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]; }
    }
  }
  return { W, H, rgba: out };
}
const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function encodePNG(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 面积平均缩放（和 canvas 的 imageSmoothingQuality='high' 接近）
function resample(img, nw, nh) {
  const out = Buffer.alloc(nw * nh * 4);
  const sx = img.W / nw, sy = img.H / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.H, Math.ceil((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.W, Math.ceil((x + 1) * sx));
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.W + xx) * 4, a = img.rgba[i + 3];
        sr += img.rgba[i] * a; sg += img.rgba[i + 1] * a; sb += img.rgba[i + 2] * a; sa += a; n++;
      }
      const d = (y * nw + x) * 4;
      if (!n || sa === 0) { out[d + 3] = 0; continue; }
      out[d] = Math.round(sr / sa); out[d + 1] = Math.round(sg / sa); out[d + 2] = Math.round(sb / sa);
      out[d + 3] = Math.round(sa / n);
    }
  }
  return { W: nw, H: nh, rgba: out };
}

// 简易盒式模糊（按 alpha 加权），用来把印刷纹理抹平 —— 这样"边线检测"才不会被纹理骗到
function boxBlur(img, r) {
  const { W, H, rgba } = img;
  const out = Buffer.from(rgba);
  const tmp = Buffer.alloc(W * H * 4);
  const pass = (src, dst, horizontal) => {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const i = (yy * W + xx) * 4, a = src[i + 3];
          sr += src[i] * a; sg += src[i + 1] * a; sb += src[i + 2] * a; sa += a; n++;
        }
        const d = (y * W + x) * 4;
        if (!n || sa === 0) { dst[d + 3] = 0; continue; }
        dst[d] = Math.round(sr / sa); dst[d + 1] = Math.round(sg / sa); dst[d + 2] = Math.round(sb / sa);
        dst[d + 3] = Math.round(sa / n);
      }
    }
  };
  pass(rgba, tmp, true);
  pass(tmp, out, false);
  return { W, H, rgba: out };
}

// 去掉面积过小的连通块（描边上的麻点）
function dropSmall(mask, W, H, minArea) {
  const n = W * H;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const areas = [];
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] !== -1) continue;
    const id = areas.length; let sp = 0; stack[sp++] = s; label[s] = id; let cnt = 0;
    const px = [];
    while (sp > 0) {
      const p = stack[--sp]; cnt++; px.push(p);
      const x = p % W, y = (p - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (!mask[q] || label[q] !== -1) continue;
        label[q] = id; stack[sp++] = q;
      }
    }
    areas.push(cnt); comps.push(px);
  }
  let dropped = 0;
  for (let i = 0; i < areas.length; i++) {
    if (areas[i] >= minArea) continue;
    for (const p of comps[i]) { mask[p] = 0; dropped++; }
  }
  return { comps: areas.length, dropped };
}

const img = decodePNG(fs.readFileSync(SRC));
// renderer 的显示框：167x200，给描边留 width+1 边距
const DW = 167, DH = 200;
const pad = opt.width + 1;
const scale = Math.min((DW - pad * 2) / img.W, (DH - pad * 2) / img.H);
const fw = Math.max(1, Math.round(img.W * scale)), fh = Math.max(1, Math.round(img.H * scale));
const frame = resample(img, fw, fh);

// ① 内部边线
if (opt.inner) {
  const W = fw, H = fh, n = W * H;
  const d = frame.rgba;
  const mask = new Uint8Array(n);
  if (opt.mode === 'parts') {
    // 分"部件"描边：先按颜色把画面切成区域，再只在不同区域的交界上画线
    //   · 对比度够大（Δmean ≥ contrast）才算"交界"，避免把渐变/阴影画成线
    //   · 两个区域都要够大（area ≥ minArea），避免把噪点当部件
    //   · **排除"深色 ↔ 白色"**：那是裙子上的黑白条纹，主人要的是"裙子只勾最外层"
    const bl = boxBlur(frame, opt.blur);
    const bd = bl.rgba;
    const label = new Int32Array(n).fill(-1);
    const stack = new Int32Array(n);
    const regions = [];
    const sum = (p) => bd[p * 4] + bd[p * 4 + 1] + bd[p * 4 + 2];
    for (let s = 0; s < n; s++) {
      if (label[s] !== -1 || bd[s * 4 + 3] < 200) continue;
      const id = regions.length;
      const seed = [bd[s * 4], bd[s * 4 + 1], bd[s * 4 + 2]];
      let sp = 0; stack[sp++] = s; label[s] = id;
      let cnt = 0, sr = 0, sg = 0, sb = 0;
      while (sp > 0) {
        const p = stack[--sp]; cnt++;
        sr += bd[p * 4]; sg += bd[p * 4 + 1]; sb += bd[p * 4 + 2];
        const x = p % W, y = (p - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (label[q] !== -1 || bd[q * 4 + 3] < 200) continue;
          const diff = Math.abs(bd[q * 4] - seed[0]) + Math.abs(bd[q * 4 + 1] - seed[1]) + Math.abs(bd[q * 4 + 2] - seed[2]);
          if (diff > opt.tol) continue;
          label[q] = id; stack[sp++] = q;
        }
      }
      regions.push({ area: cnt, r: Math.round(sr / cnt), g: Math.round(sg / cnt), b: Math.round(sb / cnt) });
    }
    // 邻接统计：哪两个区域真的贴在一起、边界有多长
    const pairLen = new Map();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x; const a = label[p];
      if (a < 0) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= W || ny >= H) continue;
        const q = ny * W + nx; const b = label[q];
        if (b < 0 || b === a) continue;
        const key = a < b ? a + ':' + b : b + ':' + a;
        pairLen.set(key, (pairLen.get(key) || 0) + 1);
      }
    }
    const isDark = (c) => Math.max(c.r, c.g, c.b) < 110;
    const isWhite = (c) => Math.min(c.r, c.g, c.b) > 195;
    let drawnPairs = 0, skippedStripes = 0, skippedLow = 0, skippedSmall = 0;
    const keep = new Set();
    for (const [key, len] of pairLen) {
      const [a, b] = key.split(':').map(Number);
      const A = regions[a], B = regions[b];
      if (len < 3) continue;
      if (A.area < opt.minArea || B.area < opt.minArea) { skippedSmall++; continue; }
      const diff = Math.abs(A.r - B.r) + Math.abs(A.g - B.g) + Math.abs(A.b - B.b);
      if (diff < opt.contrast) { skippedLow++; continue; }
      if (opt.excludeStripes && ((isDark(A) && isWhite(B)) || (isWhite(A) && isDark(B)))) { skippedStripes++; continue; }
      keep.add(key); drawnPairs++;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x; const a = label[p];
      if (a < 0) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= W || ny >= H) continue;
        const q = ny * W + nx; const b = label[q];
        if (b < 0 || b === a) continue;
        const key = a < b ? a + ':' + b : b + ':' + a;
        if (!keep.has(key)) continue;
        mask[p] = 1; mask[q] = 1;
      }
    }
    let marked = 0;
    for (let p = 0; p < n; p++) if (mask[p]) { const i = p * 4; d[i] = 20; d[i + 1] = 20; d[i + 2] = 20; marked++; }
    console.log(`内部边线(parts): 区域=${regions.length} 画线对数=${drawnPairs}（跳过条纹=${skippedStripes} 低对比=${skippedLow} 小区域=${skippedSmall}）标记像素=${marked}`);
    console.log(`  参数: blur=${opt.blur} tol=${opt.tol} contrast=${opt.contrast} minArea=${opt.minArea} 排除条纹=${opt.excludeStripes}`);
  } else if (opt.mode === 'grad') {
    // 先模糊（抹掉印刷纹理），再找"强颜色边界"，最后去掉小连通块（麻点）
    const bl = boxBlur(frame, opt.blur).rgba;
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x, i = p * 4;
        if (d[i + 3] < 200) continue;
        let mx = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = ((y + dy) * W + (x + dx)) * 4;
          if (d[j + 3] < 200) continue;
          const diff = Math.abs(bl[i] - bl[j]) + Math.abs(bl[i + 1] - bl[j + 1]) + Math.abs(bl[i + 2] - bl[j + 2]);
          if (diff > mx) mx = diff;
        }
        if (mx >= opt.thresh) mask[p] = 1;
      }
    }
    const st = dropSmall(mask, W, H, opt.minArea);
    let marked = 0;
    for (let p = 0; p < n; p++) if (mask[p]) { const i = p * 4; d[i] = 20; d[i + 1] = 20; d[i + 2] = 20; marked++; }
    console.log(`内部边线(grad): blur=${opt.blur} thresh=${opt.thresh} 连通块=${st.comps} 丢掉小碎块=${st.dropped}px 最终标记=${marked}`);
  } else {
    // 色块化：只在不同"大色块"的交界画线
    const bucket = new Int32Array(n).fill(-1);
    for (let p = 0; p < n; p++) {
      if (d[p * 4 + 3] < 200) continue;
      bucket[p] = ((d[p * 4] / opt.step | 0) * 16 + (d[p * 4 + 1] / opt.step | 0)) * 16 + (d[p * 4 + 2] / opt.step | 0);
    }
    const label = new Int32Array(n).fill(-1);
    const areas = [];
    const stack = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (bucket[s] < 0 || label[s] !== -1) continue;
      const id = areas.length; let sp = 0; stack[sp++] = s; label[s] = id; let cnt = 0;
      while (sp > 0) {
        const p = stack[--sp]; cnt++;
        const x = p % W, y = (p - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (label[q] !== -1 || bucket[q] !== bucket[s]) continue;
          label[q] = id; stack[sp++] = q;
        }
      }
      areas.push(cnt);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (label[p] < 0 || areas[label[p]] < opt.minArea) continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (label[q] < 0 || areas[label[q]] < opt.minArea || label[q] === label[p]) continue;
        mask[p] = 1; mask[q] = 1;
      }
    }
    let marked = 0;
    for (let p = 0; p < n; p++) if (mask[p]) { const i = p * 4; d[i] = 20; d[i + 1] = 20; d[i + 2] = 20; marked++; }
    console.log(`内部边线(quant): step=${opt.step} minArea=${opt.minArea} 色块数=${areas.length} 标记=${marked}`);
  }
}

// ② 外轮廓：把剪影按 16 个方向偏移 width 像素画一圈（这里直接合成到一张图里）
const DWc = DW, DHc = DH;
const canvas = Buffer.alloc(DWc * DHc * 4);   // 透明底
const ox = Math.round((DWc - fw) / 2), oy = Math.round((DHc - fh) / 2);
const put = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= DWc || y >= DHc) return;
  const i = (y * DWc + x) * 4;
  const sa = a / 255, da = canvas[i + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  canvas[i] = Math.round((r * sa + canvas[i] * da * (1 - sa)) / oa);
  canvas[i + 1] = Math.round((g * sa + canvas[i + 1] * da * (1 - sa)) / oa);
  canvas[i + 2] = Math.round((b * sa + canvas[i + 2] * da * (1 - sa)) / oa);
  canvas[i + 3] = Math.round(oa * 255);
};
if (opt.width > 0) {
  for (let k = 0; k < 16; k++) {
    const a = (Math.PI * 2 * k) / 16;
    const dxo = Math.round(Math.cos(a) * opt.width), dyo = Math.round(Math.sin(a) * opt.width);
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const i = (y * fw + x) * 4;
      if (frame.rgba[i + 3] < 40) continue;
      put(ox + x + dxo, oy + y + dyo, 20, 20, 20, 255);
    }
  }
}
for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
  const i = (y * fw + x) * 4;
  put(ox + x, oy + y, frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2], frame.rgba[i + 3]);
}

// 合成到白底 + 放大，方便看
const Z = opt.zoom;
const OW = DWc * Z, OH = DHc * Z;
const view = Buffer.alloc(OW * OH * 4);
for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
  const i = (Math.floor(y / Z) * DWc + Math.floor(x / Z)) * 4;
  const a = canvas[i + 3] / 255, d = (y * OW + x) * 4;
  view[d] = Math.round(canvas[i] * a + 255 * (1 - a));
  view[d + 1] = Math.round(canvas[i + 1] * a + 255 * (1 - a));
  view[d + 2] = Math.round(canvas[i + 2] * a + 255 * (1 - a));
  view[d + 3] = 255;
}
const OUT = opt.out ? path.resolve(ROOT, opt.out) : path.join(ROOT, 'artifacts', 'outline-preview.png');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG(OW, OH, view));
console.log(`预览: ${path.relative(ROOT, OUT)}  ${OW}x${OH}（${Z}x，显示框 ${DW}x${DH}，绘制 ${fw}x${fh}）`);
