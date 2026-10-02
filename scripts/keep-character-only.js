// 只留人物：把一张素材里"除人物以外的彩色斑块"（彩纸、叶子、花瓣…）全部清掉。
//
// 主人 2026-09-24 的要求：「去掉开心动作除人物外的所有彩色斑块」。
//
// 做法很简单也很稳：**连通块标记 → 只保留面积最大的那一块**（就是人物本人），其余全部置透明。
// 为什么不是"按颜色筛"：斑块有黄/橙/紫/红/粉/白好几种颜色，按颜色写规则永远漏；
// 而"人物是一整块连通的"这件事在这个素材上是成立的（实测：人物 174933px，
// 第二名是 11425px 的黄叶子，差一个数量级）。
//
// 安全性：工具会打印"被删掉的是哪些块"（面积/位置/颜色），并且**保留块永远不删**；
// 跑完请把成品帧合成到浅色底上看一眼（人家就是这么核对的）。
//
// 用法：
//   node scripts/keep-character-only.js                 # 体检（不写文件）
//   node scripts/keep-character-only.js --write         # 真的清（原图被覆盖，git 可回滚）
//   node scripts/keep-character-only.js --write hover   # 只处理名字含 hover 的组
//   node scripts/keep-character-only.js --write hover --keep=507,461
//        ↑ --keep=x,y：**保留**包含该像素的那一块。可重复写多个。
//          什么时候需要它：人物的某些部件可能是**独立连通块**（不跟身体连在一起）。
//          实例：`hover` 那张里**她右边那只绿色耳环**就是独立的一块（被举起的手臂挡住），
//          不特殊保护就会被当"彩色斑块"删掉 → 脸上少一只耳环。
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const GROUPS = ['idle', 'interact', 'hover', 'happy'];
const ALPHA_MIN = 24;

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
// --keep=x,y （可重复）：这些坐标所在的块不删
const KEEP_POINTS = args.filter((a) => a.startsWith('--keep='))
  .map((a) => a.slice('--keep='.length).split(',').map(Number))
  .filter((p) => p.length === 2 && p.every((n) => Number.isFinite(n)));
const ONLY = args.find((a) => !a.startsWith('--')) || null;

function decodePNG(buf) {
  let pos = 8, W = 0, H = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { W = data.readUInt32BE(0); H = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
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

// 连通块（8 邻域），返回每块的像素下标与几何/颜色统计
function labelComponents(rgba, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < ALPHA_MIN) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = start; label[start] = id;
    const pixels = [];
    let minX = W, minY = H, maxX = -1, maxY = -1, sr = 0, sg = 0, sb = 0, sa = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx - x) / W;
      pixels.push(idx);
      const i = idx * 4, a = rgba[i + 3];
      sr += rgba[i] * a; sg += rgba[i + 1] * a; sb += rgba[i + 2] * a; sa += a;
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
    comps.push({
      id, pixels, count: pixels.length, minX, minY, maxX, maxY,
      w: maxX - minX + 1, h: maxY - minY + 1,
      k: sa ? [Math.round(sr / sa), Math.round(sg / sa), Math.round(sb / sa)] : [0, 0, 0],
      avgA: Math.round(sa / pixels.length),
    });
  }
  return comps.sort((a, b) => b.count - a.count);
}

const files = [];
for (const g of GROUPS) {
  if (ONLY && !g.includes(ONLY)) continue;
  const dir = path.join(ASSETS, g);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) files.push({ group: g, file: path.join(dir, f) });
}
if (!files.length) { console.log('没找到要处理的素材。'); process.exit(0); }

console.log(`模式: ${WRITE ? '写入（真的清）' : '体检（不写文件）'}`
  + `${KEEP_POINTS.length ? `  额外保留: ${KEEP_POINTS.map((p) => `(${p[0]},${p[1]})`).join(' ')}` : ''}\n`);
let totalBlobs = 0, totalPixels = 0;
for (const { group, file } of files) {
  const { W, H, rgba } = decodePNG(fs.readFileSync(file));
  const comps = labelComponents(rgba, W, H);
  if (!comps.length) { console.log(`===== ${group}/${path.basename(file)} 空图，跳过 =====\n`); continue; }
  const main = comps[0];
  // 把 --keep 指定的点所属的块也保护起来（人物的"独立部件"，例：被手臂挡住的耳环）
  const protectedSet = new Set();
  for (const [px, py] of KEEP_POINTS) {
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    const idx = py * W + px;
    if (rgba[idx * 4 + 3] < ALPHA_MIN) continue;
    // 找出包含这个像素的块（用其中的像素下标反查）
    const hit = comps.find((c) => c.pixels.includes(idx));
    if (hit) protectedSet.add(hit.id);
  }
  const blobs = comps.slice(1).filter((c) => !protectedSet.has(c.id));
  const kept = comps.slice(1).filter((c) => protectedSet.has(c.id));
  console.log(`===== ${group}/${path.basename(file)}  ${W}x${H}  连通块 ${comps.length} =====`);
  console.log(`  【人物·保留】${String(main.count).padStart(7)}px ${String(main.w).padStart(4)}x${String(main.h).padStart(4)}`
    + `@(${main.minX},${main.minY})  avgRGB=${main.k.join(',')} avgA=${main.avgA}`);
  for (const c of kept) {
    console.log(`  【--keep 指定·保留】${String(c.count).padStart(6)}px ${String(c.w).padStart(4)}x${String(c.h).padStart(4)}`
      + `@(${c.minX},${c.minY})  avgRGB=${c.k.join(',')} avgA=${c.avgA}  ← 是人物的一部分（例：耳环）`);
  }
  if (!blobs.length) {
    console.log('  （没有别的块可删）\n');
    continue;
  }
  for (const c of blobs) {
    console.log(`  【彩色斑块·删】${String(c.count).padStart(6)}px ${String(c.w).padStart(4)}x${String(c.h).padStart(4)}`
      + `@(${String(c.minX).padStart(4)},${String(c.minY).padStart(4)})  avgRGB=${c.k.join(',').padEnd(13)} avgA=${c.avgA}`);
  }
  const px = blobs.reduce((s, c) => s + c.count, 0);
  totalBlobs += blobs.length; totalPixels += px;
  console.log(`  → 将清掉 ${blobs.length} 块 / ${px} 像素（人物那一块不动）`);
  if (WRITE) {
    for (const c of blobs) for (const idx of c.pixels) rgba[idx * 4 + 3] = 0;
    fs.writeFileSync(file, encodePNG(W, H, rgba));
    console.log('  → 已写回');
  }
  console.log('');
}
console.log(`合计: ${WRITE ? '已清理' : '将清理'} ${totalBlobs} 块 / ${totalPixels} 像素`);
if (!WRITE) console.log('\n（确认无误后加 --write 执行；素材有 git 记录，随时可回滚）');
