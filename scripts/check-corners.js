// 四角体检：报告每帧四个"角落象限"里的内容量，用于确认残留是否清干净。
// 用法: node scripts/check-corners.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const ALPHA_MIN = 40;

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

const CORNER = 0.30; // 角落象限占比
for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    const img = decodePNG(fs.readFileSync(path.join(dir, f)));
    const { width: W, height: H, rgba } = img;
    const cw = Math.round(W * CORNER), chh = Math.round(H * CORNER);
    const corners = [
      { name: '左上', x0: 0, y0: 0 }, { name: '右上', x0: W - cw, y0: 0 },
      { name: '左下', x0: 0, y0: H - chh }, { name: '右下', x0: W - cw, y0: H - chh },
    ];
    const parts = corners.map((c) => {
      let n = 0, minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = c.y0; y < Math.min(H, c.y0 + chh); y++) {
        for (let x = c.x0; x < Math.min(W, c.x0 + cw); x++) {
          if (rgba[(y * W + x) * 4 + 3] < ALPHA_MIN) continue;
          n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
      const dens = n / (cw * chh);
      const tag = n === 0 ? '空' : (dens < 0.06 ? '稀疏' : '有内容');
      return `${c.name}:${String(n).padStart(6)}px(${tag})${n && dens < 0.06 ? ` @(${minX},${minY})` : ''}`;
    });
    console.log(`${(d + '/' + f).padEnd(22)} ${String(W + 'x' + H).padEnd(11)} ${parts.join('  ')}`);
  }
}
console.log('\n说明: 角落象限取图像宽高的 30%；"稀疏"= 密度<6%（残留的典型特征）');
