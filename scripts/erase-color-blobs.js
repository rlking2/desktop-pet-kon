// 按颜色"抠掉"压在人物身上的彩色斑块（可指定种子，保证只动那几块）
//
// 背景（主人 2026-09-24）：靠近动作里还有两块彩色斑块（她肩膀上的黄块 + 橙叶子）
// **是压在人物身上的**，所以它们和人物连成一个连通块 ——
// "只保留最大连通块"那种做法抓不到它们。
//
// 做法（四步）：
//   ① 颜色关键值筛出候选像素（可给多个关键值，容差宽松一点没关系）
//   ② 对候选像素做连通块标记，**只保留包含 --seed 指定点的那些块**
//      （这一步是安全阀：颜色筛会顺带命中她的金发和白叶子的粉色描边，用种子就能排除掉）
//   ③ 把选中的块**外扩**几像素，把斑块自己的深色描边一起吃掉
//   ④ 补洞：每个被删的像素，找**最近的"没被删"的像素**——
//         最近的是实心像素 → 复制它的颜色（压在裙子上就补成裙子色）
//         最近的是透明像素 → 变透明（伸到背景里的那部分）
//      （这比"整块填黑"稳：斑块通常一半压在人物身上、一半在背景里）
//
// 用法：
//   node scripts/erase-color-blobs.js --file=assets/hover/frame-01.png \
//        --key=229,193,88,90 --key=238,116,54,90 --seed=465,520 --seed=540,570
//   （默认只体检：列出颜色块清单 + 种子命中情况；加 --write 才真的写）
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = { file: null, keys: [], seeds: [], write: false, dilate: 5 };
for (const a of args) {
  if (a === '--write') opt.write = true;
  else if (a.startsWith('--file=')) opt.file = a.slice(7);
  else if (a.startsWith('--dilate=')) opt.dilate = Number(a.slice(9));
  else if (a.startsWith('--key=')) opt.keys.push(a.slice(6).split(',').map(Number));
  else if (a.startsWith('--seed=')) opt.seeds.push(a.slice(7).split(',').map(Number));
}
if (!opt.file) { console.error('必须给 --file=素材路径'); process.exit(2); }
if (!opt.keys.length || !opt.seeds.length) { console.error('必须给至少一个 --key 和一个 --seed'); process.exit(2); }
const FILE = path.resolve(ROOT, opt.file);

function decodePNG(buf) {
  let pos = 8, W = 0, H = 0, ct = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const t = buf.toString('ascii', pos + 4, pos + 8);
    const d = buf.subarray(pos + 8, pos + 8 + len);
    if (t === 'IHDR') { W = d.readUInt32BE(0); H = d.readUInt32BE(4); ct = d[9]; }
    else if (t === 'IDAT') idat.push(d);
    else if (t === 'IEND') break;
    pos += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
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

const { W, H, rgba } = decodePNG(fs.readFileSync(FILE));
const idx = (x, y) => y * W + x;

// ① 颜色关键值 → 候选掩码
const cand = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = idx(x, y), a = rgba[i * 4 + 3];
    if (a < 40) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    for (const [kr, kg, kb, tol] of opt.keys) {
      const d = Math.sqrt((r - kr) ** 2 + (g - kg) ** 2 + (b - kb) ** 2);
      if (d <= (tol || 60)) { cand[i] = 1; break; }
    }
  }
}

// ② 候选掩码的连通块（8 邻域）
const label = new Int32Array(W * H).fill(-1);
const comps = [];
const stack = new Int32Array(W * H);
for (let start = 0; start < W * H; start++) {
  if (!cand[start] || label[start] !== -1) continue;
  const id = comps.length;
  let sp = 0; stack[sp++] = start; label[start] = id;
  let n = 0, minX = W, minY = H, maxX = -1, maxY = -1;
  while (sp > 0) {
    const p = stack[--sp];
    const x = p % W, y = (p - x) / W;
    n++;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const np = idx(nx, ny);
      if (!cand[np] || label[np] !== -1) continue;
      label[np] = id;
      if (sp < stack.length) stack[sp++] = np;
    }
  }
  comps.push({ id, n, minX, minY, maxX, maxY });
}
console.log(`文件: ${opt.file}  ${W}x${H}`);
console.log(`颜色筛出候选块 ${comps.length} 个（容差内的所有连通块）:`);
for (const c of comps.sort((a, b) => b.n - a.n).slice(0, 12)) {
  console.log(`  #${String(c.id).padStart(2)}  ${String(c.n).padStart(6)}px  bbox ${c.maxX - c.minX + 1}x${c.maxY - c.minY + 1}@(${c.minX},${c.minY})`);
}

// ③ 种子 → 选中哪些块
const chosen = new Set();
for (const [sx, sy] of opt.seeds) {
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) { console.error(`种子 (${sx},${sy}) 超出画布`); process.exit(2); }
  const l = label[idx(sx, sy)];
  if (l === -1) { console.error(`种子 (${sx},${sy}) 不在任何候选块里 —— 换个点，或放宽 --key 容差`); process.exit(2); }
  chosen.add(l);
}
console.log(`\n种子命中 ${chosen.size} 个块:`);
let eraseN = 0;
const inRegion = new Set();
for (const c of comps) if (chosen.has(c.id)) {
  console.log(`  ✔ #${c.id}  ${c.n}px  bbox ${c.maxX - c.minX + 1}x${c.maxY - c.minY + 1}@(${c.minX},${c.minY})`);
  for (let y = c.minY; y <= c.maxY; y++) for (let x = c.minX; x <= c.maxX; x++) if (label[idx(x, y)] === c.id) inRegion.add(idx(x, y));
}
eraseN = inRegion.size;

// ③b 外扩：把斑块自己的深色描边一起吃掉
let erase = new Uint8Array(W * H);
for (const p of inRegion) erase[p] = 1;
for (let it = 0; it < opt.dilate; it++) {
  const next = Uint8Array.from(erase);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = idx(x, y);
    if (erase[p]) continue;
    let near = false;
    for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (erase[idx(nx, ny)]) { near = true; break; }
    }
    if (near) next[p] = 1;
  }
  erase = next;
}
let eraseTotal = 0;
for (let p = 0; p < W * H; p++) if (erase[p]) eraseTotal++;
console.log(`\n外扩 ${opt.dilate}px：要删的像素 ${eraseN} → ${eraseTotal}`);

// ④ 补洞：每个被删像素取"最近的非删除像素"的颜色/透明度
//    用多源 BFS 从"所有非删除像素"出发，第一次到达谁，就抄谁
const src = new Int32Array(W * H).fill(-1);
const queue = new Int32Array(W * H);
let qh = 0, qt = 0;
for (let p = 0; p < W * H; p++) if (!erase[p]) { src[p] = p; queue[qt++] = p; }
while (qh < qt) {
  const p = queue[qh++];
  const x = p % W, y = (p - x) / W;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const np = idx(nx, ny);
    if (src[np] !== -1) continue;
    src[np] = src[p];
    queue[qt++] = np;
  }
}
let filledOpaque = 0, filledClear = 0;
for (let p = 0; p < W * H; p++) {
  if (!erase[p]) continue;
  const s = src[p];
  const i = p * 4, j = s * 4;
  if (s < 0 || rgba[j + 3] < 40) { rgba[i + 3] = 0; filledClear++; continue; }
  rgba[i] = rgba[j]; rgba[i + 1] = rgba[j + 1]; rgba[i + 2] = rgba[j + 2]; rgba[i + 3] = 255;
  filledOpaque++;
}
console.log(`补洞：抄人物颜色 ${filledOpaque} px，变透明 ${filledClear} px`);
if (opt.write) {
  fs.writeFileSync(FILE, encodePNG(W, H, rgba));
  console.log('\n已写回 ' + opt.file);
} else {
  console.log('\n（体检模式，没有写文件；确认无误后加 --write）');
}
