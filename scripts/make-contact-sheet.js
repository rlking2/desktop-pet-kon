// 把 cutout 结果拼成一张网格预览图，方便用绘图的"拼图/多图"视图横向比较抠图质量。
// 用法: node scripts/make-contact-sheet.js [目录] [输出文件]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const DIR = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'assets', 'cutout');
const OUT = process.argv[3] ? path.resolve(process.argv[3]) : path.join(ROOT, 'artifacts', 'cutout-preview.png');

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

const files = fs.readdirSync(DIR).filter((f) => /\.png$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
if (!files.length) { console.log('目录里没有 PNG: ' + DIR); process.exit(0); }

const imgs = files.map((f) => ({ name: f, img: decodePNG(fs.readFileSync(path.join(DIR, f))) }));
const COLS = 5, CELL = 140, PAD = 8, LABEL = 12;
const rows = Math.ceil(imgs.length / COLS);
const W = COLS * CELL + PAD, H = rows * (CELL + LABEL) + PAD;
const sheet = Buffer.alloc(W * H * 4);
// 浅灰棋盘背景（方便看清透明区域）
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const c = ((x >> 3) + (y >> 3)) % 2 === 0 ? 236 : 208;
    sheet[i] = c; sheet[i + 1] = c; sheet[i + 2] = c; sheet[i + 3] = 255;
  }
}
imgs.forEach((item, k) => {
  const cx = PAD + (k % COLS) * CELL, cy = PAD + Math.floor(k / COLS) * (CELL + LABEL);
  const s = Math.min((CELL - 10) / item.img.width, (CELL - 10) / item.img.height);
  const tw = Math.round(item.img.width * s), th = Math.round(item.img.height * s);
  const ox = cx + Math.round((CELL - tw) / 2), oy = cy + Math.round((CELL - th) / 2);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(item.img.width - 1, Math.floor(x / s));
      const sy = Math.min(item.img.height - 1, Math.floor(y / s));
      const si = (sy * item.img.width + sx) * 4;
      const a = item.img.rgba[si + 3] / 255;
      if (a <= 0.02) continue;
      const di = ((oy + y) * W + (ox + x)) * 4;
      sheet[di] = Math.round(item.img.rgba[si] * a + sheet[di] * (1 - a));
      sheet[di + 1] = Math.round(item.img.rgba[si + 1] * a + sheet[di + 1] * (1 - a));
      sheet[di + 2] = Math.round(item.img.rgba[si + 2] * a + sheet[di + 2] * (1 - a));
      sheet[di + 3] = 255;
    }
  }
  // 顶部一条深色标签带，用像素编码序号（画不了字，就画等宽色块代表文件名长度）
  const barY = cy + CELL;
  for (let x = 0; x < CELL; x++) {
    for (let y = 0; y < LABEL - 2; y++) {
      const di = ((barY + y) * W + (cx + x)) * 4;
      const isLabel = x < files[k].length * 3;
      const v = isLabel ? 60 : 170;
      sheet[di] = v; sheet[di + 1] = v; sheet[di + 2] = v; sheet[di + 3] = 255;
    }
  }
});

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePNG(W, H, sheet));
console.log(`拼接预览图: ${path.relative(ROOT, OUT)}  ${W}x${H}`);
console.log(`顺序（从左到右、从上到下）: ${files.join(', ')}`);
console.log('每个格子下方深色条的长度 = 文件名长度（方便对应，图里没法画字）');
