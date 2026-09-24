// 统计"贴边低 alpha 像素"的分布，判断是否存在"幽灵轮廓"（抠图残留的一圈淡边）。
// 判据思路：
//   - 主体内部也有半透明像素（柔边、发丝），所以不能一刀切
//   - 幽灵轮廓的特征是：**贴边 + alpha 偏低 + 离主体远**
// 这里只做统计与报告，供人判断是否要清。
//
// 用法: node scripts/check-halo.js
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

// 主连通域（alpha>=40）的包围盒，用来判断"离主体远不远"
function mainBBox(rgba, W, H) {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  let best = null;
  for (let start = 0; start < W * H; start++) {
    if (seen[start] || rgba[start * 4 + 3] < 40) continue;
    let sp = 0; stack[sp++] = start; seen[start] = 1;
    let count = 0, minX = W, minY = H, maxX = -1, maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx - x) / W;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nidx = ny * W + nx;
        if (seen[nidx] || rgba[nidx * 4 + 3] < 40) continue;
        seen[nidx] = 1;
        if (sp < stack.length) stack[sp++] = nidx;
      }
    }
    if (!best || count > best.count) best = { count, minX, minY, maxX, maxY };
  }
  return best;
}

console.log('幽灵轮廓检查：统计"贴边 + 低 alpha + 离主体远"的像素\n');
for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    const img = decodePNG(fs.readFileSync(path.join(dir, f)));
    const { width: W, height: H, rgba } = img;
    const main = mainBBox(rgba, W, H);
    if (!main) continue;
    const dist = 12; // 距主体包围盒多远算"远"
    let farLow = 0, farMid = 0, nearLow = 0;
    let fx0 = W, fy0 = H, fx1 = -1, fy1 = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const a = rgba[(y * W + x) * 4 + 3];
        if (a < 8) continue;
        const nearMain = x >= main.minX - dist && x <= main.maxX + dist && y >= main.minY - dist && y <= main.maxY + dist;
        if (nearMain) { if (a < 40) nearLow++; continue; }
        if (a < 40) { farLow++; if (x < fx0) fx0 = x; if (y < fy0) fy0 = y; if (x > fx1) fx1 = x; if (y > fy1) fy1 = y; }
        else farMid++;
      }
    }
    const label = `${d}/${f}`.padEnd(22) + `${W}x${H}`.padEnd(11);
    console.log(`${label}主体 bbox ${main.maxX - main.minX + 1}x${main.maxY - main.minY + 1}@(${main.minX},${main.minY})`);
    console.log(`${''.padEnd(33)}远处低alpha(${8}~39): ${String(farLow).padStart(6)}px`
      + `  远处中alpha(40+): ${String(farMid).padStart(6)}px`
      + `  主体附近低alpha: ${String(nearLow).padStart(6)}px`);
    if (farLow > 0) console.log(`${''.padEnd(33)}远处低alpha 的范围: (${fx0},${fy0})~(${fx1},${fy1})`);
  }
}
