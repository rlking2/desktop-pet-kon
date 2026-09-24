// 抠图残留物检测：找出"不属于主体的小连通块"（比如图里的编号/水印/角标没抠掉）。
//
// 原理（不靠眼睛）：
//   1) 对 alpha 通道做连通域标记
//   2) 最大的那块 = 主体
//   3) 其它块按面积排序，报告位置与面积；在画面角落的小块极可能是残留标注
//
// 用法: node scripts/find-residue.js [目录或文件]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const target = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'assets', 'cutout');

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

// 连通域标记（8 邻域，迭代版避免递归爆栈）
function components(rgba, W, H, alphaMin = 40) {
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1) continue;
    if (rgba[start * 4 + 3] < alphaMin) continue;
    const id = comps.length;
    let sp = 0;
    stack[sp++] = start;
    label[start] = id;
    let count = 0, minX = W, minY = H, maxX = -1, maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx - x) / W;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const nidx = ny * W + nx;
          if (label[nidx] !== -1) continue;
          if (rgba[nidx * 4 + 3] < alphaMin) continue;
          label[nidx] = id;
          if (sp < stack.length) stack[sp++] = nidx;
        }
      }
    }
    comps.push({ id, count, minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  return comps;
}

const files = [];
if (fs.statSync(target).isDirectory()) {
  for (const f of fs.readdirSync(target)) if (/\.png$/i.test(f)) files.push(path.join(target, f));
} else files.push(target);
files.sort();

for (const f of files) {
  let img;
  try { img = decodePNG(fs.readFileSync(f)); }
  catch (err) { console.log(`${path.basename(f)} 解码失败: ${err.message}`); continue; }
  const { width: W, height: H, rgba } = img;
  const comps = components(rgba, W, H);
  if (!comps.length) { console.log(`${path.basename(f)}: 全透明（内容为空）`); continue; }
  comps.sort((a, b) => b.count - a.count);
  const main = comps[0];
  const mainArea = main.count;
  const others = comps.slice(1).filter((c) => c.count > 0.0002 * mainArea || c.count > 600);

  console.log(`\n===== ${path.basename(f)}  ${W}x${H} =====`);
  console.log(`主体: 面积 ${mainArea}px  bbox ${main.w}x${main.h}@(${main.minX},${main.minY})`);
  console.log(`连通块总数: ${comps.length}   明显的小块: ${others.length}`);
  if (others.length) {
    console.log('  小块清单（按面积）:');
    for (const c of others.slice(0, 12)) {
      const cx = c.minX + c.w / 2, cy = c.minY + c.h / 2;
      // 判断在哪个角
      const nearLeft = cx < W * 0.25, nearRight = cx > W * 0.75;
      const nearTop = cy < H * 0.25, nearBottom = cy > H * 0.75;
      const corner = (nearTop ? '上' : nearBottom ? '下' : '') + (nearLeft ? '左' : nearRight ? '右' : '');
      const where = corner ? `${corner}角` : '画面中';
      console.log(`    ${String(c.count).padStart(7)}px  bbox ${String(c.w).padStart(4)}x${String(c.h).padStart(4)}@(${String(c.minX).padStart(4)},${String(c.minY).padStart(4)})`
        + `  占主体 ${(c.count / mainArea * 100).toFixed(2)}%  位置=${where}`);
    }
  } else {
    console.log('  ✅ 没有明显的小块残留');
  }
}
