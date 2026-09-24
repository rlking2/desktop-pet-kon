// 残留物清理 + 局部放大预览
//
// 用途：
//   1) 裁出指定区域并放大，方便主人肉眼确认"那是不是残留的数字/水印"
//   2) 按面积阈值删掉"不属于主体的小连通块"（编号、水印碎片、灰尘点）
//
// 用法:
//   node scripts/clean-residue.js 7.png --crop=0,0,120,140 --zoom=4   # 裁出左上角并放大 4 倍
//   node scripts/clean-residue.js 7.png --min-area=3000               # 删掉小于 3000px 的连通块
//   node scripts/clean-residue.js --all --min-area=3000               # 处理 cutout 里所有图
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const CUT = path.join(ROOT, 'assets', 'cutout');
const OUT = path.join(ROOT, 'artifacts', 'residue');

const args = process.argv.slice(2);
const opt = { file: null, all: false, crop: null, zoom: 3, minArea: 0, scanCorners: false, cleanCorner: null };
for (const a of args) {
  if (a === '--all') opt.all = true;
  else if (a === '--scan-corners') opt.scanCorners = true;
  else if (a.startsWith('--clean-corner=')) opt.cleanCorner = a.split('=')[1].split(',').map(Number);
  else if (a.startsWith('--crop=')) opt.crop = a.split('=')[1].split(',').map(Number);
  else if (a.startsWith('--zoom=')) opt.zoom = Number(a.split('=')[1]);
  else if (a.startsWith('--min-area=')) opt.minArea = Number(a.split('=')[1]);
  else if (!a.startsWith('--')) opt.file = a;
}

function decodePNG(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? line[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      line[i] = v & 0xff;
    }
    prev = line;
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = (y * width + x) * 4;
      if (ch >= 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; }
      out[d + 3] = ch === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, rgba: out };
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

function components(rgba, W, H, alphaMin = 40) {
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1) continue;
    if (rgba[start * 4 + 3] < alphaMin) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = start; label[start] = id;
    const pixels = [];
    let minX = W, minY = H, maxX = -1, maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx - x) / W;
      pixels.push(idx);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nidx = ny * W + nx;
        if (label[nidx] !== -1 || rgba[nidx * 4 + 3] < alphaMin) continue;
        label[nidx] = id;
        if (sp < stack.length) stack[sp++] = nidx;
      }
    }
    comps.push({ id, count: pixels.length, pixels, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  return comps;
}

// 裁一块并最近邻放大（放大用最近邻，方便看清像素本身）
function cropZoom(rgba, W, H, x0, y0, cw, ch, zoom) {
  const ow = cw * zoom, oh = ch * zoom;
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = x0 + Math.floor(x / zoom), sy = y0 + Math.floor(y / zoom);
      const di = (y * ow + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) { out[di + 3] = 0; continue; }
      const si = (sy * W + sx) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2];
      out[di + 3] = rgba[si + 3];
    }
  }
  return { rgba: out, w: ow, h: oh };
}

fs.mkdirSync(OUT, { recursive: true });

// 边角清理：把指定矩形区域内的像素全部置为透明。
// 用途：原图角落的手写编号/角标（主人反馈"7.png 左上角的 7 没抠掉"）用连通域按面积删不可靠
//      ——一个数字常被切成好几块、面积也未必小；直接按"区域"清最稳。
//
// 安全性检查（不靠眼睛）：只清"稀疏区域"。若该区域里不透明像素占比 > 25%，
//      说明这里可能是角色本体，工具会拒绝执行并提示主人。
function cleanCorner(rgba, W, H, x0, y0, cw, ch) {
  let opaque = 0, total = 0;
  for (let y = y0; y < Math.min(H, y0 + ch); y++) {
    for (let x = x0; x < Math.min(W, x0 + cw); x++) {
      total++;
      if (rgba[(y * W + x) * 4 + 3] >= 40) opaque++;
    }
  }
  const density = total ? opaque / total : 0;
  if (density > 0.25) {
    return { ok: false, density: +density.toFixed(3), opaque,
      reason: `区域不透明像素占比 ${(density * 100).toFixed(1)}% > 25%，可能是角色本体，拒绝清理` };
  }
  for (let y = y0; y < Math.min(H, y0 + ch); y++) {
    for (let x = x0; x < Math.min(W, x0 + cw); x++) {
      rgba[(y * W + x) * 4 + 3] = 0;
    }
  }
  return { ok: true, density: +density.toFixed(3), opaque };
}

// 自动检测"角落残留"：扫描四个角，找稀疏但不为空的小块，报告候选矩形
function findCornerResidue(rgba, W, H) {
  const bandW = Math.round(W * 0.28), bandH = Math.round(H * 0.24);
  const corners = [
    { name: '左上', x0: 0, y0: 0 },
    { name: '右上', x0: W - bandW, y0: 0 },
    { name: '左下', x0: 0, y0: H - bandH },
    { name: '右下', x0: W - bandW, y0: H - bandH },
  ];
  const out = [];
  for (const c of corners) {
    let opaque = 0, minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = c.y0; y < Math.min(H, c.y0 + bandH); y++) {
      for (let x = c.x0; x < Math.min(W, c.x0 + bandW); x++) {
        if (rgba[(y * W + x) * 4 + 3] < 40) continue;
        opaque++;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    const total = bandW * bandH;
    out.push({ name: c.name, opaque, density: +(opaque / total).toFixed(4), bbox: maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 } });
  }
  return out;
}

const files = opt.all
  ? fs.readdirSync(CUT).filter((f) => /\.png$/i.test(f)).map((f) => path.join(CUT, f)).sort()
  : [opt.file ? path.resolve(CUT, opt.file) : null].filter(Boolean);

if (!files.length) {
  console.log('用法: node scripts/clean-residue.js 7.png --crop=0,0,120,140 --zoom=4');
  console.log('      node scripts/clean-residue.js --all --min-area=3000');
  process.exit(0);
}

for (const f of files) {
  const base = path.basename(f).replace(/\.png$/i, '');
  const img = decodePNG(fs.readFileSync(f));
  const { width: W, height: H, rgba } = img;
  console.log(`\n===== ${path.basename(f)}  ${W}x${H} =====`);

  // 0) 四角残留扫描（只报告，不改文件）
  if (opt.scanCorners) {
    const res = findCornerResidue(rgba, W, H);
    console.log('  四角残留扫描：');
    for (const r of res) {
      const hint = r.opaque === 0 ? '空（干净）'
        : r.density < 0.06 ? '⚠️ 稀疏但有内容 → 疑似编号/角标残留'
          : r.density < 0.25 ? '内容较多 → 可能是角色的手/头发'
            : '内容很密 → 应该是角色本体';
      console.log(`    ${r.name}: 不透明 ${String(r.opaque).padStart(6)}px  密度 ${(r.density * 100).toFixed(1)}%  `
        + `bbox ${r.bbox ? `${r.bbox.w}x${r.bbox.h}@(${r.bbox.minX},${r.bbox.minY})` : '-'}  ${hint}`);
    }
  }

  // 1) 局部放大预览
  if (opt.crop) {
    const [x0, y0, cw, ch] = opt.crop;
    const z = cropZoom(rgba, W, H, x0, y0, cw, ch, opt.zoom);
    const outPath = path.join(OUT, `${base}-crop-${x0}_${y0}.png`);
    fs.writeFileSync(outPath, encodePNG(z.w, z.h, z.rgba));
    console.log(`  局部放大 ${cw}x${ch} @(${x0},${y0})  x${opt.zoom} → ${path.relative(ROOT, outPath)}  (${z.w}x${z.h})`);
  }

  // 2) 按面积清理小连通块
  if (opt.minArea > 0) {
    const comps = components(rgba, W, H);
    comps.sort((a, b) => b.count - a.count);
    const keep = comps[0];
    const removed = [];
    const out = Buffer.from(rgba);
    for (const c of comps.slice(1)) {
      if (c.count >= opt.minArea) continue;
      for (const idx of c.pixels) out[idx * 4 + 3] = 0;
      removed.push(c);
    }
    const outPath = path.join(CUT, `${base}.png`);
    fs.writeFileSync(outPath, encodePNG(W, H, out));
    console.log(`  清理：删掉 ${removed.length} 个小块（阈值 ${opt.minArea}px），保留主体 ${keep.count}px`);
    for (const c of removed.slice(0, 8)) {
      console.log(`    - ${String(c.count).padStart(6)}px  bbox ${c.w}x${c.h}@(${c.minX},${c.minY})`);
    }
    if (removed.length > 8) console.log(`    ...（共 ${removed.length} 块）`);
    console.log(`  已写回 ${path.relative(ROOT, outPath)}`);
  }

  // 3) 边角清理（针对手写编号/角标）
  if (opt.cleanCorner) {
    const [x0, y0, cw, ch] = opt.cleanCorner;
    const r = cleanCorner(img.rgba, W, H, x0, y0, cw, ch);
    if (!r.ok) {
      console.log(`  ❌ 拒绝清理区域 (${x0},${y0}) ${cw}x${ch}：${r.reason}`);
    } else {
      const outPath = path.join(CUT, `${base}.png`);
      fs.writeFileSync(outPath, encodePNG(W, H, img.rgba));
      console.log(`  ✅ 已清理区域 (${x0},${y0}) ${cw}x${ch}：清掉 ${r.opaque}px（原密度 ${(r.density * 100).toFixed(1)}%），已写回 ${path.relative(ROOT, outPath)}`);
    }
  }
}
