// 打印某帧"顶部 N 行"的横向密度图（每格 8x2 像素），看清顶部残留的形状。
// 用法: node scripts/top-map.js idle/frame-02.png [行数]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');

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

const rel = process.argv[2] || 'idle/frame-02.png';
const ROWS = Number(process.argv[3]) || 80;
const img = decodePNG(fs.readFileSync(path.join(ASSETS, rel)));
const { width: W, height: H, rgba } = img;

console.log(`${rel}  ${W}x${H}  顶部 ${ROWS} 行密度图（每格 8x4 像素）`);
console.log('      ' + Array.from({ length: Math.ceil(W / 8) }, (_, i) => (i % 5 === 0 ? String(i * 8 % 1000).padStart(8) : '')).join('').slice(0, 120));

for (let y = 0; y < ROWS; y += 4) {
  let line = String(y).padStart(4) + '  ';
  for (let x = 0; x < W; x += 8) {
    let c = 0, t = 0;
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 8; dx++) {
        if (y + dy >= H || x + dx >= W) continue;
        t++;
        if (rgba[((y + dy) * W + (x + dx)) * 4 + 3] >= 40) c++;
      }
    }
    const d = t ? c / t : 0;
    line += (d === 0 ? ' ' : d < 0.15 ? '.' : d < 0.35 ? ':' : d < 0.6 ? '+' : d < 0.85 ? '#' : '@');
  }
  console.log(line);
}
