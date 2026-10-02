// 清掉素材里的「页面残留」（主人 2026-09-24：待机动画下方有白线、右下有白线框）
//
// 背景：这些素材是从**书页照片**上裁下来的。除了角色本人，画面里还混着页面自己的东西：
//   · 页面下边框的灰色横线（半透明深灰 → 在白底桌面上看着像"白线"）
//   · 右下角的**粉色线稿徽标**（圆角方框 + 数字 6/8 + 一个水滴）—— 每张图里都有
//   · 左上角一段淡粉圆弧（邻格画面的残留）
//   · 画布边角上的灰色小污点
//
// ⚠️ 但不能"把所有淡色块都删掉"：图里还有一种**白色叶子装饰**（跟黄/橙叶子同一套），
//    它的白色叶肉在抠背景时被吃掉了，只剩深色轮廓 + 半透明叶脉 —— 它**是角色的一部分**，
//    删了就等于把装饰删掉。所以判据不能只看"淡"，得看**颜色构成**：
//
//   残留（粉色线稿）：大部分像素是"粉"的   → R-G 明显为正 且 B ≥ G（粉/品红方向）
//   残留（灰色线）：  大部分像素是"中性深灰" → 三通道接近且偏暗
//   白色叶子：        主要是"暖深色轮廓"   → 偏暗，但 R-B 明显为正（棕/褐），且不是粉色主导
//
// 用法：
//   node scripts/clean-pagemarks.js                  # 体检（默认不写文件），列出每块的判据与结论
//   node scripts/clean-pagemarks.js --write          # 真的清掉（原图会被覆盖，git 里可回滚）
//   node scripts/clean-pagemarks.js --write idle     # 只处理名字含 idle 的组
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const GROUPS = ['idle', 'interact', 'hover', 'happy'];
const ALPHA_MIN = 24;      // 与素材体检工具一致：低于这个 alpha 的像素不算"画上去的东西"

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ONLY = args.find((a) => !a.startsWith('--')) || null;

// ---------- PNG 解码/编码（8bit，非隔行；够用即可，不引第三方库） ----------
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

// ---------- 连通块 + 颜色特征 ----------
function labelComponents(rgba, W, H) {
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  const stack = new Int32Array(W * H);
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < ALPHA_MIN) continue;
    const id = comps.length;
    let sp = 0; stack[sp++] = start; label[start] = id;
    const pixels = [];
    let minX = W, minY = H, maxX = -1, maxY = -1;
    let pink = 0, neutralDark = 0, warmDark = 0, sumR = 0, sumG = 0, sumB = 0, sumA = 0;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % W, y = (idx - x) / W;
      pixels.push(idx);
      const i = idx * 4, r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sumR += r * a; sumG += g * a; sumB += b * a; sumA += a;
      // 粉/品红方向：R 明显大于 G，且 **B 大于 G**（粉红色偏蓝，红/褐色偏黄）
      // —— 这条把"页码线稿/水滴"（实测 B > G）和"红褐色叶子"（B < G）分开了
      if (r - g >= 30 && b > g) pink++;
      if (mx <= 140 && mx - mn <= 18) neutralDark++;             // 中性深灰（页面边框线）
      if (mx <= 150 && r - b >= 20) warmDark++;                  // 暖深色（白叶子的棕黑轮廓）
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
      id, count: pixels.length, pixels, minX, minY, maxX, maxY,
      w: maxX - minX + 1, h: maxY - minY + 1,
      k: sumA ? [Math.round(sumR / sumA), Math.round(sumG / sumA), Math.round(sumB / sumA)] : [0, 0, 0],
      avgA: Math.round(sumA / pixels.length),
      pinkFrac: +(pink / pixels.length).toFixed(2),
      neutralFrac: +(neutralDark / pixels.length).toFixed(2),
      warmFrac: +(warmDark / pixels.length).toFixed(2),
    });
  }
  return comps;
}

// ---------- 判定：这块是不是"页面残留" ----------
// 只对**淡块**下手（avgA < 200）：角色/彩纸/叶子都是实心的（实测 avgA ≥ 205），
// 页面线稿必然是半透明的（实测 40~130）。
//
// ⚠️ 踩坑（人家差点删错）：一开始只用"颜色"判据 —— 粉色像素占比 ≥ 45% 就当成页码线稿。
//   结果 `interact/frame-03` 里有一片 **粉色叶子**（4903px，avgA=76，粉=0.71）被误判成残留！
//   它是跟白/黄/橙/紫叶子同一套的装饰，只是叶肉偏白、被抠背景时吃掉了一部分。
//   所以必须再加一条**形状**判据：**线稿的"填充率"极低**（笔画细、中间是空的），
//     页码框/圆弧/页面边框线实测 0.01~0.18，而叶子这类紧凑色块 ≥ 0.30。
function classify(c, W, H) {
  if (c.avgA >= 200) return { kill: false, why: '实心（是画面内容，不动）' };
  const fill = c.count / (c.w * c.h);
  // ① 粉色**线稿**：页码徽标（圆角框+数字）、淡粉圆弧、水滴。
  //    ⚠️ 这一条必须排在"紧凑色块豁免"**前面**：泡泡一样的水滴填充率有 0.32，
  //    先豁免就会被漏掉（实测漏过一颗 589px 的水滴）。
  //    判据用 `B > G`（粉偏蓝）而不是 `B >= G-10` —— 后者会把红褐色的叶子也算成"粉"。
  if (c.pinkFrac >= 0.45) {
    return { kill: true, dust: c.count < 100,
      why: `粉色线稿（粉=${Math.round(c.pinkFrac * 100)}%，填充率 ${fill.toFixed(2)}）→ 页码徽标/圆弧/水滴` };
  }
  // ② 中性深灰：页面边框线、角上的灰印
  if (c.neutralFrac >= 0.40 && c.pinkFrac < 0.20) {
    return { kill: true, dust: false, why: `中性深灰（灰=${Math.round(c.neutralFrac * 100)}%）→ 页面边框线/角标` };
  }
  // ③ 暖深色轮廓 → "白叶子"（叶肉被抠没了，但轮廓和叶脉还在）
  if (c.warmFrac >= 0.35) {
    return { kill: false, why: `暖深色轮廓（暖=${Math.round(c.warmFrac * 100)}%）→ 是"白叶子"装饰，留着` };
  }
  // ④ 紧凑色块（叶子一类的装饰）：哪怕它淡、哪怕偏粉，也是画的一部分
  if (fill >= 0.30 && c.count >= 300) {
    return { kill: false, why: `紧凑色块（填充率 ${fill.toFixed(2)}，非粉色主导）→ 叶子/装饰，不是线稿` };
  }
  // ⑤ 极淡小噪点：alpha 40 上下、不到 100 像素，合成到浅色桌面上 ≈ 246/255，肉眼不可见
  if (c.count < 100 && c.avgA <= 120) {
    return { kill: true, dust: true, why: '极淡小噪点（肉眼不可见）' };
  }
  return { kill: false, why: '拿不准 → 保守留着（宁可少删）' };
}

// ---------- 主流程 ----------
const files = [];
for (const g of GROUPS) {
  if (ONLY && !g.includes(ONLY)) continue;
  const dir = path.join(ASSETS, g);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) files.push({ group: g, file: path.join(dir, f) });
}
if (!files.length) { console.log('没找到要处理的素材。'); process.exit(0); }

let totalKilled = 0, totalPixels = 0;
console.log(`模式: ${WRITE ? '写入（真的清）' : '体检（不写文件）'}\n`);
for (const { group, file } of files) {
  const { W, H, rgba } = decodePNG(fs.readFileSync(file));
  const comps = labelComponents(rgba, W, H).sort((a, b) => b.count - a.count);
  const kills = [];
  let dustCount = 0, dustPixels = 0;
  console.log(`===== ${group}/${path.basename(file)}  ${W}x${H}  连通块 ${comps.length} 个 =====`);
  for (const [i, c] of comps.entries()) {
    const v = classify(c, W, H);
    // 主体（最大块）永远不动
    const isMain = i === 0;
    const kill = v.kill && !isMain;
    if (kill) {
      kills.push(c);
      if (v.dust) { dustCount++; dustPixels += c.count; }
    }
    if (v.dust && kill && !isMain) continue;   // 噪点单独汇总，不逐条刷屏
    const tag = isMain ? '【主体·不动】' : (kill ? '【删】' : '【留】');
    if (kill || c.count >= 300 || (c.avgA < 200 && (c.pinkFrac >= 0.3 || c.neutralFrac >= 0.3 || c.warmFrac >= 0.3))) {
      console.log(`  ${tag} ${String(c.count).padStart(6)}px ${String(c.w).padStart(4)}x${String(c.h).padStart(4)}`
        + `@(${String(c.minX).padStart(4)},${String(c.minY).padStart(4)})`
        + `  avgRGB=${c.k.join(',').padEnd(13)} avgA=${String(c.avgA).padStart(3)}`
        + `  粉=${c.pinkFrac} 灰=${c.neutralFrac} 暖=${c.warmFrac}`);
      console.log(`        ↳ ${v.why}`);
    }
  }
  if (dustCount) console.log(`  （另有 ${dustCount} 个极淡小噪点 / ${dustPixels} 像素，合成后肉眼不可见，一并清掉）`);
  if (kills.length) {
    const px = kills.reduce((s, c) => s + c.count, 0);
    totalKilled += kills.length; totalPixels += px;
    console.log(`  → 本图将清掉 ${kills.length} 块 / ${px} 像素`);
    if (WRITE) {
      for (const c of kills) for (const idx of c.pixels) rgba[idx * 4 + 3] = 0;
      fs.writeFileSync(file, encodePNG(W, H, rgba));
      console.log('  → 已写回');
    }
  } else {
    console.log('  → 没有需要清理的块');
  }
  console.log('');
}
console.log(`合计: ${WRITE ? '已清理' : '将清理'} ${totalKilled} 块 / ${totalPixels} 像素`);
if (!WRITE) console.log('\n（确认无误后加 --write 执行；素材有 git 记录，随时可回滚）');
