// 把图片的"不透明分布"渲染成文字地图，让人（和看不见图的模型）都能看出构图。
// 用法: node scripts/ascii-map.js assets/cutout/7.png [列数]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

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

const file = process.argv[2] || path.join(__dirname, '..', 'assets', 'cutout', '7.png');
const COLS = Number(process.argv[3]) || 64;
const img = decodePNG(fs.readFileSync(file));
const { width: W, height: H, rgba } = img;
const cellW = W / COLS;
const ROWS = Math.max(8, Math.round((H / W) * COLS * 0.5)); // 字符是高的，行数按 0.5 修正
const cellH = H / ROWS;

// 两级字符：密/疏
const chars = ' .:-=+*#%@';
console.log(`${path.basename(file)}  ${W}x${H}  →  ${COLS} 列 x ${ROWS} 行`);
console.log(`每格 ${cellW.toFixed(1)}x${cellH.toFixed(1)} 像素；字符越靠右表示该格不透明像素越多`);
console.log(`图例: 空格=空  . : - = + * # % @ = 逐渐变密\n`);

let header = '     ';
for (let c = 0; c < COLS; c += 8) header += String(Math.round(c * cellW)).padEnd(8);
console.log(header);

for (let r = 0; r < ROWS; r++) {
  let line = String(Math.round(r * cellH)).padStart(4) + ' ';
  for (let c = 0; c < COLS; c++) {
    let opaque = 0, total = 0;
    const x0 = Math.floor(c * cellW), x1 = Math.min(W, Math.ceil((c + 1) * cellW));
    const y0 = Math.floor(r * cellH), y1 = Math.min(H, Math.ceil((r + 1) * cellH));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) { total++; if (rgba[(y * W + x) * 4 + 3] >= 40) opaque++; }
    }
    const d = total ? opaque / total : 0;
    const idx = d === 0 ? 0 : Math.min(chars.length - 1, 1 + Math.floor(d * (chars.length - 1.001)));
    line += chars[idx];
  }
  console.log(line);
}
