// 专清"残留细线"：只删满足**全部**下列条件的连通块
//   1) 形状极细长（长宽比 >= 5:1）—— 编号/边框/裁切线都是细的
//   2) 填充率很低（面积 / 外接矩形 <= 0.25）—— 细线的外接矩形几乎全是空的
//   3) 贴边（外接矩形触到图像外圈 2% 的带状区）—— 残留总在最外层
//   4) 面积不超过主体的 3% —— 避免删到角色的大部件
//
// 为什么这么保守：人家在 idle/interact 的连通域里发现多个"独立大块"其实是
// **角色的手 / 小动物 / 分离的装饰**（如 idle/frame-01 里 2167px@(270,289)），
// 按"只留最大块"清会把这些一起删掉 —— 那比留着残留更糟。
//
// 用法:
//   node scripts/clean-thin-lines.js             # 只报告
//   node scripts/clean-thin-lines.js --apply     # 执行
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const APPLY = process.argv.includes('--apply');
const ALPHA_MIN = 40;
const MIN_ASPECT = 5;      // 长宽比下限
const MAX_FILL = 0.25;     // 填充率上限
const EDGE_BAND = 0.02;    // 贴边判定带
const MAX_MAIN_RATIO = 0.03; // 相对主体的面积上限

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

const crcTable = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type, 'ascii'); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, crc]); }
function encodePNG(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
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
  return { label, comps };
}

function classify(c, W, H, mainCount) {
  const aspect = Math.max(c.w / c.h, c.h / c.w);
  const fill = c.count / (c.w * c.h);
  const minDim = Math.min(c.w, c.h);
  const bandX = Math.max(2, Math.round(W * EDGE_BAND)), bandY = Math.max(2, Math.round(H * EDGE_BAND));
  const touchesEdge = c.minX <= bandX || c.minY <= bandY || c.maxX >= W - 1 - bandX || c.maxY >= H - 1 - bandY;
  const smallEnough = c.count <= mainCount * MAX_MAIN_RATIO;
  // "细"有两种形态，必须都认：
  //   a) 某个维度极小（比如 527x1 的一条横线，填充率是 1.0 但它就是一条线！）
  //   b) 外形还算方但内部极稀疏（比如 130x208 却只有 2246px，是镂空的边框）
  // ⚠️ 踩坑：一开始只写了 fill <= 0.25，结果 527x1 的横线（fill=1.0）被漏掉，
  //    而它正是主人报的"残留线"。
  const isThinShape = aspect >= MIN_ASPECT && (minDim <= 3 || fill <= MAX_FILL);
  const isThin = isThinShape && touchesEdge && smallEnough;
  return { aspect: +aspect.toFixed(1), fill: +fill.toFixed(3), minDim, touchesEdge, smallEnough, isThin };
}

console.log(`清理"残留细线"${APPLY ? ' —— 执行' : ' —— 只报告，加 --apply 执行'}`);
console.log(`判据: 长宽比>=${MIN_ASPECT} 且 填充率<=${MAX_FILL} 且 贴边 且 面积<=主体的${(MAX_MAIN_RATIO * 100).toFixed(0)}%\n`);

let totalRemoved = 0, totalPixels = 0, framesTouched = 0;
for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    const full = path.join(dir, f);
    const img = decodePNG(fs.readFileSync(full));
    const { width: W, height: H, rgba } = img;
    const { label, comps } = labelComponents(rgba, W, H);
    comps.sort((a, b) => b.count - a.count);
    const main = comps[0];
    if (!main) continue;

    const thin = [];
    for (const c of comps.slice(1)) {
      const info = classify(c, W, H, main.count);
      if (info.isThin) thin.push({ ...c, ...info });
    }
    const label2 = `${d}/${f}`.padEnd(22) + `${W}x${H}`.padEnd(11);
    if (!thin.length) { console.log(`${label2}✅ 没有残留细线`); continue; }

    const px = thin.reduce((a, b) => a + b.count, 0);
    console.log(`${label2}找到 ${thin.length} 条残留细线，共 ${px}px（主体 ${main.count}px）`);
    for (const c of thin) {
      console.log(`${''.padEnd(33)}  - ${String(c.count).padStart(6)}px bbox ${String(c.w).padStart(4)}x${String(c.h).padStart(4)}`
        + `@(${String(c.minX).padStart(4)},${String(c.minY).padStart(4)})  长宽比 ${c.aspect}  填充 ${c.fill}  贴边=${c.touchesEdge}`);
    }
    if (APPLY) {
      const out = Buffer.from(rgba);
      for (const c of thin) {
        // 按"连通域像素 + 其外接矩形内的中低 alpha 像素"一起清，避免留下半透明毛边
        for (let y = c.minY; y <= c.maxY; y++) {
          for (let x = c.minX; x <= c.maxX; x++) {
            if (label[y * W + x] === c.id) out[(y * W + x) * 4 + 3] = 0;
          }
        }
      }
      fs.writeFileSync(full, encodePNG(W, H, out));
      console.log(`${''.padEnd(33)}✅ 已清理`);
      totalRemoved += thin.length; totalPixels += px; framesTouched++;
    }
  }
}
console.log(`\n${APPLY ? `共清理 ${totalRemoved} 条细线 / ${totalPixels}px，涉及 ${framesTouched} 帧` : '未执行（加 --apply）'}`);
if (APPLY && totalRemoved) {
  console.log('\n下一步：重新生成清单');
  for (const d of ['idle', 'interact', 'hover']) console.log(`  node scripts/inspect-assets.js ${d} --write --normalize-height`);
}
