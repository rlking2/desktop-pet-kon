// 量每帧"逐行不透明像素数"，找出主体真正开始的行，用于判断"清掉顶部几行"是否安全。
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

const files = [];
for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) files.push(`${d}/${f}`);
}

console.log('逐行不透明像素（前 40 行）—— 找"主体真正开始"的行');
console.log('图例: . 空   ░ 少量   ▓ 中等   █ 大量(>50%宽)\n');
for (const f of files) {
  const img = decodePNG(fs.readFileSync(path.join(ASSETS, f)));
  const { width: W, height: H, rgba } = img;
  const prof = [];
  for (let y = 0; y < 40; y++) {
    let c = 0;
    for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3] >= 40) c++;
    prof.push(c);
  }
  let start = -1;
  for (let y = 0; y < 40; y++) if (prof[y] >= W * 0.25) { start = y; break; }
  const bar = prof.map((v) => (v === 0 ? '.' : v > W * 0.5 ? '#' : v > W * 0.15 ? '+' : '-')).join('');
  console.log(`${f.padEnd(22)} ${String(W + 'x' + H).padEnd(11)} [${bar}]`);
  console.log(`${''.padEnd(34)}前 40 行共 ${String(prof.reduce((a, b) => a + b, 0)).padStart(6)}px   主体起点 y=${start < 0 ? '>40' : start}`);
}
