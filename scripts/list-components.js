// 列出每帧所有连通块的几何数据（面积/外接矩形/长宽比/填充率/是否贴边），
// 用来人工核对"哪些是残留、哪些是角色的独立部件"。
// 用法: node scripts/list-components.js [idle/frame-03.png]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const ONLY = process.argv[2] || null;
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

function labelComponents(rgba, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < ALPHA_MIN) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = start; label[start] = id;
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
        if (label[nidx] !== -1 || rgba[nidx * 4 + 3] < ALPHA_MIN) continue;
        label[nidx] = id;
        if (sp < stack.length) stack[sp++] = nidx;
      }
    }
    comps.push({ id, count, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  return comps;
}

const files = [];
if (ONLY) files.push(ONLY);
else for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) files.push(`${d}/${f}`);
}

for (const rel of files) {
  const img = decodePNG(fs.readFileSync(path.join(ASSETS, rel)));
  const { width: W, height: H, rgba } = img;
  const comps = labelComponents(rgba, W, H).sort((a, b) => b.count - a.count);
  const main = comps[0];
  console.log(`\n===== ${rel}  ${W}x${H} =====`);
  console.log(`主体: ${main.count}px  bbox ${main.w}x${main.h}@(${main.minX},${main.minY})`);
  console.log(`其它块 ${comps.length - 1} 个：`);
  console.log('     面积    bbox(w x h)      位置        长宽比 填充率 贴边');
  for (const c of comps.slice(1, 21)) {
    const aspect = Math.max(c.w / c.h, c.h / c.w);
    const fill = c.count / (c.w * c.h);
    const bandX = Math.max(2, Math.round(W * 0.03)), bandY = Math.max(2, Math.round(H * 0.03));
    const edge = c.minX <= bandX || c.minY <= bandY || c.maxX >= W - 1 - bandX || c.maxY >= H - 1 - bandY;
    const ratio = (c.count / main.count * 100).toFixed(2);
    console.log(`  ${String(c.count).padStart(7)}px  ${String(c.w).padStart(4)}x${String(c.h).padStart(4)}`
      + `  @(${String(c.minX).padStart(4)},${String(c.minY).padStart(4)})  ${aspect.toFixed(1).padStart(6)}`
      + ` ${fill.toFixed(3)}  ${edge ? '是' : '否'}   占主体 ${ratio}%`);
  }
  if (comps.length - 1 > 20) console.log(`  ...（共 ${comps.length - 1} 块）`);
}
