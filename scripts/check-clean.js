// 最终清洁度检查：把每帧分为"左上角区"和"其它区域"，分别统计，
// 并检查左上角区在"主体起点以上"是否还有内容（那才是残留的判据）。
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

let allClean = true;
for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    const img = decodePNG(fs.readFileSync(path.join(dir, f)));
    const { width: W, height: H, rgba } = img;
    // 主体起点
    let subjectStart = -1;
    for (let y = 0; y < H; y++) {
      let minX = -1, maxX = -1;
      for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3] >= ALPHA_MIN) { if (minX < 0) minX = x; maxX = x; }
      if (minX < 0) continue;
      if (maxX - minX + 1 >= W * 0.25) { subjectStart = y; break; }
    }
    // 左上角区（左 40% x 主体起点以上）的内容
    const rw = Math.round(W * 0.4);
    let leftTop = 0, ltMin = [W, H], ltMax = [-1, -1];
    for (let y = 0; y < (subjectStart < 0 ? Math.round(H * 0.3) : subjectStart); y++) {
      for (let x = 0; x < rw; x++) {
        if (rgba[(y * W + x) * 4 + 3] < ALPHA_MIN) continue;
        leftTop++;
        if (x < ltMin[0]) ltMin[0] = x; if (y < ltMin[1]) ltMin[1] = y;
        if (x > ltMax[0]) ltMax[0] = x; if (y > ltMax[1]) ltMax[1] = y;
      }
    }
    const ok = leftTop <= 20; // 允许极少量抗锯齿残点
    if (!ok) allClean = false;
    console.log(`${(d + '/' + f).padEnd(22)} ${String(W + 'x' + H).padEnd(11)} 主体起点 y=${String(subjectStart).padStart(4)}`
      + `   左上角区(主体起点以上)内容 ${String(leftTop).padStart(5)}px  ${ok ? '✅ 干净' : '⚠️ 仍有内容 @(' + ltMin.join(',') + ')~(' + ltMax.join(',') + ')'}`);
  }
}
console.log(`\n${allClean ? '✅ 全部帧的左上角残留已清干净' : '⚠️ 仍有帧存在左上角内容，请查看上面标注'}`);
