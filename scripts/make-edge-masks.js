// 生成「部件描边掩码」：按颜色把每一帧切成"部件区域"，只在**部件的外交界**上画线。
//
// 主人 2026-09-24 的要求：
//   「头发，眉毛，手，裙子**只勾最外层**，腿和脚」—— 也就是：
//     · 要在这些部件的**轮廓**上画线
//     · 裙子上的**黑白条纹不许勾**（那是裙子内部的花纹，不是外层轮廓）
//     · 头发内部的深浅花纹、脸上的阴影也不许勾（那是同一部件内部的东西）
//
// 两个关键判据（都是踩过坑换来的）：
//   ① **同一色系的两个区域之间不画线** —— 头发的受光/背光两种金色之间那条线是"头发内部花纹"，
//      只按色差判会把它整片涂红（人家第一版就是这样，整个刘海都红了）。
//   ② **排除"深色 ↔ 白色"这一对** —— 那正是裙子上的黑白条纹 → 于是"裙子只勾最外层"自动成立。
//
// 为什么在**原图分辨率**上算、而不是屏上那 91~163px 的小图：
//   屏上太小，泛洪会碎成几百个碎块（实测 91x196 时"小区域"被跳过 213 次）；
//   原图里头发有 200x250px、裙子更大，区域才站得住。算完把掩码**加粗后再缩小**给屏上用。
//
// 用法：
//   node scripts/make-edge-masks.js --preview          # 出"原图+红线"对照图，肉眼核对
//   node scripts/make-edge-masks.js --verbose          # 打印每一条被选中的交界（谁和谁、色差多少）
//   node scripts/make-edge-masks.js                    # 写 assets/build/edges/<组>/<帧>.png
//   node scripts/make-edge-masks.js --tol=70 --contrast=110 --min-area=800 --blur=2
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const GROUPS = ['idle', 'interact', 'hover', 'happy'];

const args = process.argv.slice(2);
const opt = {
  // 这几个默认值是调出来的（见 devlog/round-19.md、round-21.md、round-22.md）：
  // 直接跑就能复现成品掩码。lineWidth 是"希望缩到屏上有多粗"，
  // 主人 2026-09-24 把描边粗细定在 0.25px，所以基础线也按 0.35 生成（≈ 屏上 0.25px）。
  tol: 140, contrast: 110, minArea: 800, partMin: 900, blur: 3,
  lineWidth: 0.35, preview: false, verbose: false, excludeStripes: true, only: null,
};
for (const a of args) {
  if (a === '--preview') opt.preview = true;
  else if (a === '--verbose') opt.verbose = true;
  else if (a.startsWith('--tol=')) opt.tol = Number(a.slice('--tol='.length));
  else if (a.startsWith('--contrast=')) opt.contrast = Number(a.slice('--contrast='.length));
  else if (a.startsWith('--min-area=')) opt.minArea = Number(a.slice('--min-area='.length));
  else if (a.startsWith('--blur=')) opt.blur = Number(a.slice('--blur='.length));
  else if (a.startsWith('--line-width=')) opt.lineWidth = Number(a.slice('--line-width='.length));
  else if (a.startsWith('--stripes=')) opt.excludeStripes = a.slice('--stripes='.length) !== '0';
  else if (!a.startsWith('--')) opt.only = a;
}
// 屏上显示框（renderer 里 DISP_W_MAX=167 / DISP_H=200）
const DISP_W = 167, DISP_H = 200;

// ---------- PNG 读写 ----------
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

function boxBlur(img, r) {
  const { W, H } = img;
  const out = Buffer.alloc(W * H * 4);
  const tmp = Buffer.alloc(W * H * 4);
  const pass = (src, dst, horizontal) => {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let k = -r; k <= r; k++) {
        const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = (yy * W + xx) * 4, a = src[i + 3];
        sr += src[i] * a; sg += src[i + 1] * a; sb += src[i + 2] * a; sa += a; n++;
      }
      const d = (y * W + x) * 4;
      if (!n || sa === 0) { dst[d + 3] = 0; continue; }
      dst[d] = Math.round(sr / sa); dst[d + 1] = Math.round(sg / sa); dst[d + 2] = Math.round(sb / sa);
      dst[d + 3] = Math.round(sa / n);
    }
  };
  pass(img.rgba, tmp, true);
  pass(tmp, out, false);
  return { W, H, rgba: out };
}

// ---------- 颜色分区（部件色系）----------
// 同一色系的两个区域之间的交界**不算部件边界**（头发内部花纹、脸上阴影、裙子条纹都属于这种）
//
// ⚠️ 顺序即优先级，"hair" 这条要**够宽**：头发的受光色 (196,172,133) 和背光色 (124,113,95)
//    色差高达 169 —— 比"头发 vs 肤色"的 114 还大！所以不能靠色差阈值区分，
//    必须让**两种金色都归到 hair**（判据：暖色 r>g>b 且 b<165），否则整个刘海会被画成红线。
const CLASSES = [
  { name: 'white', test: (r, g, b) => Math.min(r, g, b) > 190 && Math.max(r, g, b) - Math.min(r, g, b) < 45 },
  // ★ 'dark' 必须排除"暖的深色"：头发的暗部（例：124,113,95）比黑裙子（46,48,30）只是更暗一点，
  //   如果都算 dark，那么"头发亮部(hair) ↔ 头发暗部(dark)"就成了**跨色系**，
  //   于是整个刘海会被描成一堆又粗又断的线（主人 2026-09-24 报的"后面几帧图线过厚且割裂"就是这个）。
  //   暖色判据 `r>g>b 且 r-b≥15` 能把"头发的棕"和"裙子的中性黑(46,48,30 里 r<g)"分开。
  { name: 'dark', test: (r, g, b) => Math.max(r, g, b) < 110 && !(r > g && g > b && r - b >= 15) },
  { name: 'green', test: (r, g, b) => g - Math.max(r, b) > 12 },
  { name: 'skin', test: (r, g, b) => r > 205 && b >= 165 && g >= 175 && r > g && g > b },
  // hair 要**够宽**：印刷品扫描里头发有受光金 (196,172,133)、背光棕 (124,113,95)、
  //   甚至偏橄榄的暗色 (128,131,84) —— 三种必须是**同一个色系**，否则"头发内部"会被当成
  //   跨色系交界描出来（主人报的"开心第三帧图线过厚且割裂"就是这个原因）。
  { name: 'hair', test: (r, g, b) => b < 165 && r >= b && g >= b && Math.max(r, g, b) >= 110 && Math.max(r, g, b) < 215 },
  { name: 'pink', test: (r, g, b) => r - g > 25 && b > g - 5 },       // 偏品红（腮红一类）
];
function classOf(c) {
  for (const cl of CLASSES) if (cl.test(c.r, c.g, c.b)) return cl.name;
  return 'other';
}

// ---------- 核心：算出"部件交界线"掩码 ----------
function partEdgeMask(img, cfg) {
  const { W, H } = img;
  const n = W * H;
  const bd = boxBlur(img, cfg.blur).rgba;
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let regions = [];

  // ① 容差泛洪分割
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || bd[s * 4 + 3] < 200) continue;
    const id = regions.length;
    const seedR = bd[s * 4], seedG = bd[s * 4 + 1], seedB = bd[s * 4 + 2];
    let sp = 0; stack[sp++] = s; label[s] = id;
    let cnt = 0, sr = 0, sg = 0, sb = 0;
    let rminX = W, rminY = H, rmaxX = -1, rmaxY = -1;
    while (sp > 0) {
      const p = stack[--sp]; cnt++;
      sr += bd[p * 4]; sg += bd[p * 4 + 1]; sb += bd[p * 4 + 2];
      const x = p % W, y = (p - x) / W;
      if (x < rminX) rminX = x; if (x > rmaxX) rmaxX = x;
      if (y < rminY) rminY = y; if (y > rmaxY) rmaxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const q = ny * W + nx;
        if (label[q] !== -1 || bd[q * 4 + 3] < 200) continue;
        const diff = Math.abs(bd[q * 4] - seedR) + Math.abs(bd[q * 4 + 1] - seedG) + Math.abs(bd[q * 4 + 2] - seedB);
        if (diff > cfg.tol) continue;
        label[q] = id; stack[sp++] = q;
      }
    }
    const mean = { r: Math.round(sr / cnt), g: Math.round(sg / cnt), b: Math.round(sb / cnt) };
    const bw = rmaxX - rminX + 1, bh = rmaxY - rminY + 1;
    regions.push({
      area: cnt, sr, sg, sb, r: mean.r, g: mean.g, b: mean.b, cls: classOf(mean),
      fill: +(cnt / Math.max(1, bw * bh)).toFixed(2),   // 填充率：紧凑色块 ≈ 0.5+，细长条带 < 0.3
    });
  }

  // ①b 邻接表（像素级 → 区域对）：key "小:大" → 两个区域贴在一起的像素对数
  const adj = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, a = label[p];
    if (a < 0) continue;
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx >= W || ny >= H) continue;
      const b = label[ny * W + nx];
      if (b < 0 || b === a) continue;
      const key = a < b ? a + ':' + b : b + ':' + a;
      adj.set(key, (adj.get(key) || 0) + 1);
    }
  }

  // ② 区分"部件"和"线"：
  //     面积 ≥ partMin 的算**部件**；比它小的算**线**（原画的描边线、眼睛的线、缝隙…）。
  //     ⚠️ 不能把这些"线"直接并进邻居 —— 并了以后区域的**平均色会变**，
  //        色系分类跟着错位（人家试过：并完把眼睛和裙子条纹都描成了红块）。
  //     所以：**线不参与颜色判定，只当"部件之间的桥"**——
  //        一条线同时挨着部件 A 和部件 B，就说明 A 和 B 是相邻的两个部件；
  //        要不要画线，看的是 **A、B 自己的颜色**（没被污染）。
  const partMin = cfg.partMin;
  const isPart = (lab) => regions[lab].area >= partMin;
  const neighborsOf = new Map();   // label → Map(邻居label → 交界长度)
  for (const [key, len] of adj) {
    const [a, b] = key.split(':').map(Number);
    if (!neighborsOf.has(a)) neighborsOf.set(a, new Map());
    if (!neighborsOf.has(b)) neighborsOf.set(b, new Map());
    neighborsOf.get(a).set(b, len);
    neighborsOf.get(b).set(a, len);
  }
  const isDark = (c) => c.cls === 'dark';
  const isWhite = (c) => c.cls === 'white';
  // 两个部件之间要不要画线。`viaLine` = 中间隔着的那条线（用来判"同色系但被轮廓线分开"的情况）
  const acceptPair = (A, B, viaLine, len) => {
    if (A.cls === B.cls) {
      // ★ 例外只给 **dark ↔ dark**（黑手套 vs 黑裙子这种"两个深色部件"）。
      //   ⚠️ 千万别扩大到别的色系：头发亮部/暗部都是 hair，而**原画里头发上那几笔发丝线**
      //      也是"深色细块 + 两边都是头发"，一旦放行就会被描出来 ——
      //      主人 2026-09-24 报的「开心后面几帧图线过厚、跟前面割裂」就是这个：
      //      第三帧的发丝线比前两帧多，于是那一帧的头发被描得又粗又乱，跟前两帧完全不像。
      const bothDark = A.cls === 'dark' && B.cls === 'dark';
      const T = viaLine != null ? regions[viaLine] : null;
      const boldLine = bothDark && T && Math.max(T.r, T.g, T.b) < 105 && T.area <= Math.max(400, cfg.partMin * 2);
      const darkPair = bothDark && len >= 60 && Math.min(A.fill, B.fill) >= 0.3;
      if ((boldLine || darkPair) && A.area >= cfg.partMin && B.area >= cfg.partMin) {
        return { ok: true, diff: 999, why: '两块深色部件的分界（例：黑手套 vs 黑裙子）' };
      }
      return { ok: false, why: 'sameClass' };
    }
    const diff = Math.abs(A.r - B.r) + Math.abs(A.g - B.g) + Math.abs(A.b - B.b);
    // ★ 「深色」那一侧必须**成块**（填充率 ≥ 0.3）：否则它就是原画的一笔**细线**
    //   （头发上的发丝线、脸部的描边线…），不该被当成"部件"描出来。
    //   主人报的"开心后面几帧图线过厚"就是这些发丝线（第三帧特别多）。
    if (isDark(A) && A.fill < 0.3) return { ok: false, why: 'thinDark' };
    if (isDark(B) && B.fill < 0.3) return { ok: false, why: 'thinDark' };
    if (diff < cfg.contrast) return { ok: false, why: 'lowContrast' };
    if (cfg.excludeStripes && ((isDark(A) && isWhite(B)) || (isWhite(A) && isDark(B)))) {
      return { ok: false, why: 'stripes' };                                  // 裙子黑白条纹
    }
    return { ok: true, diff };
  };
  const stat = { pairs: 0, stripes: 0, lowContrast: 0, small: 0, sameClass: 0, viaLine: 0 };
  const keptInfo = [];
  // 所有"该画线"的部件对（直接相邻的 + 隔着一条线相邻的）
  const goodPairs = new Set();
  for (const [lab, nbrs] of neighborsOf) {
    if (!isPart(lab)) continue;
    // 直接相邻
    for (const [m] of nbrs) {
      if (!isPart(m) || m === lab) continue;
      const pk = lab < m ? lab + ':' + m : m + ':' + lab;
      if (goodPairs.has(pk) || keptInfo.some((x) => x.key === pk)) continue;
      const v = acceptPair(regions[lab], regions[m], null, nbrs.get(m) || 0);
      if (v.ok) { goodPairs.add(pk); stat.pairs++; keptInfo.push({ key: pk, text: `    ${regions[lab].cls}(${regions[lab].r},${regions[lab].g},${regions[lab].b})[${regions[lab].area}px] ↔ ${regions[m].cls}(${regions[m].r},${regions[m].g},${regions[m].b})[${regions[m].area}px]  直接相邻 Δ=${v.diff}${v.why ? '  ← ' + v.why : ''}` }); }
      else stat[v.why]++;
    }
    // 隔着一条"线"相邻：这条线同时挨着 lab 和 m → lab 和 m 是部件邻居
    for (const [line] of nbrs) {
      if (isPart(line)) continue;
      const lineNbrs = neighborsOf.get(line) || new Map();
      for (const [m] of lineNbrs) {
        if (m === lab || !isPart(m)) continue;
        const pk = lab < m ? lab + ':' + m : m + ':' + lab;
        if (goodPairs.has(pk) || keptInfo.some((x) => x.key === pk)) continue;
        const v = acceptPair(regions[lab], regions[m], line, nbrs.get(line) || 0);
        if (v.ok) {
          goodPairs.add(pk); stat.pairs++; stat.viaLine++;
          keptInfo.push({ key: pk, text: `    ${regions[lab].cls}[${regions[lab].area}px] ↔(隔线) ${regions[m].cls}[${regions[m].area}px]  Δ=${v.diff}${v.why ? '  ← ' + v.why : ''}` });
        } else stat[v.why]++;
      }
    }
  }
  if (cfg.verbose) for (const it of keptInfo) console.log(it.text);
  if (cfg.verbose) {
    // 调参最有用的一栏：把"色差很大却因为同一色系被挡掉"的对打出来
    const shown = new Set();
    for (const [key, len] of adj) {
      if (len < 20) continue;
      const [a, b] = key.split(':').map(Number);
      if (!isPart(a) || !isPart(b)) continue;
      const A = regions[a], B = regions[b];
      const diff = Math.abs(A.r - B.r) + Math.abs(A.g - B.g) + Math.abs(A.b - B.b);
      if (diff < 200) continue;
      const sig = A.cls + '|' + B.cls;
      if (shown.has(sig)) continue;
      shown.add(sig);
      console.log(`    [被挡] ${A.cls}(${A.r},${A.g},${A.b})[${A.area}px] ↔ ${B.cls}(${B.r},${B.g},${B.b})[${B.area}px]  Δ=${diff} 交界${len}px`);
    }
  }

  // ③ 掩码：贴着"该画线的部件对"的那薄薄一层像素（不是整块线区域，避免把耳环整块涂黑）
  const mask = new Uint8Array(n);
  const pairOf = (x, y) => {
    const l = label[y * W + x];
    return l < 0 ? -1 : l;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = pairOf(x, y);
    if (l < 0) continue;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const m = pairOf(nx, ny);
      if (m < 0 || m === l) continue;
      // 相邻两格必须"其中一格是部件"，且这一对（或它俩所属的部件对）在名单里
      const A = isPart(l) ? l : -1, B = isPart(m) ? m : -1;
      let ok = false;
      if (A >= 0 && B >= 0) ok = goodPairs.has(A < B ? A + ':' + B : B + ':' + A);
      else {
        // 一格是线：看这条线挨着的两个部件对是否在名单里
        const line = A >= 0 ? m : l, part = A >= 0 ? A : B;
        for (const [other] of (neighborsOf.get(line) || new Map())) {
          if (!isPart(other) || other === part) continue;
          const pk = part < other ? part + ':' + other : other + ':' + part;
          if (goodPairs.has(pk)) { ok = true; break; }
        }
      }
      if (ok) { mask[y * W + x] = 1; mask[ny * W + nx] = 1; }
    }
  }
  return { mask, regions: regions.length, stat, mergedCount: 0 };
}

// ---------- 主流程 ----------
const files = [];
for (const g of GROUPS) {
  if (opt.only && !g.includes(opt.only)) continue;
  const dir = path.join(ASSETS, 'build', 'frames', g);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    files.push({ group: g, src: path.join(dir, f), name: f });
  }
}
if (!files.length) { console.error('没找到成品帧，先跑素材构建'); process.exit(2); }

console.log(`参数: tol=${opt.tol} contrast=${opt.contrast} minArea=${opt.minArea} blur=${opt.blur}`
  + ` 排除条纹=${opt.excludeStripes}\n`);
for (const { group, src, name } of files) {
  const img = decodePNG(fs.readFileSync(src));
  const t0 = Date.now();
  const { mask, regions, stat, mergedCount } = partEdgeMask(img, opt);
  const { W, H } = img;
  // 掩码要"缩到屏上还有约 lineWidth px"，所以在原图这一侧先加粗：
  //   屏上缩放比 = min(167/W, 200/H)（和 renderer 的显示框一致）
  const dispScale = Math.min(DISP_W / W, DISP_H / H);
  const radius = Math.max(0, Math.round(opt.lineWidth / dispScale) - 1);
  const dilated = new Uint8Array(W * H);
  if (radius <= 0) {
    dilated.set(mask);
  } else {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let dy = -radius; dy <= radius; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= H) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= W) continue;
          dilated[ny * W + nx] = 1;
        }
      }
    }
  }
  let marked = 0;
  const maskRgba = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    if (!dilated[p]) continue;
    marked++;
    maskRgba[p * 4] = 255; maskRgba[p * 4 + 1] = 255; maskRgba[p * 4 + 2] = 255; maskRgba[p * 4 + 3] = 255;
  }
  console.log(`${group}/${name}  ${W}x${H}  区域=${regions}（合并掉 ${mergedCount} 个碎片）  画线对数=${stat.pairs}`
    + `（跳过 同色系=${stat.sameClass} 条纹=${stat.stripes} 低对比=${stat.lowContrast} 小区域=${stat.small}）`
    + `  屏上缩放=${dispScale.toFixed(3)} 原图加粗=${radius}px  掩码像素=${marked}  ${Date.now() - t0}ms`);
  const outDir = path.join(ASSETS, 'build', 'edges', group);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, name), encodePNG(W, H, maskRgba));

  if (opt.preview) {
    const scale = Math.min(1, 700 / H);
    const OW = Math.round(W * scale), OH = Math.round(H * scale);
    const view = Buffer.alloc(OW * OH * 4);
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
      const sx = Math.min(W - 1, Math.floor(x / scale)), sy = Math.min(H - 1, Math.floor(y / scale));
      const i = (sy * W + sx) * 4, d = (y * OW + x) * 4;
      let hit = false;
      for (let k = 0; k < 3 && !hit; k++) for (let m = 0; m < 3; m++) {
        const qx = Math.min(W - 1, sx + m), qy = Math.min(H - 1, sy + k);
        if (dilated[qy * W + qx]) { hit = true; break; }
      }
      const a = img.rgba[i + 3] / 255;
      if (hit) { view[d] = 255; view[d + 1] = 0; view[d + 2] = 0; }
      else {
        view[d] = Math.round(img.rgba[i] * a + 255 * (1 - a));
        view[d + 1] = Math.round(img.rgba[i + 1] * a + 255 * (1 - a));
        view[d + 2] = Math.round(img.rgba[i + 2] * a + 255 * (1 - a));
      }
      view[d + 3] = 255;
    }
    const pv = path.join(ROOT, 'artifacts', `edges-${group}-${name}`);
    fs.writeFileSync(pv, encodePNG(OW, OH, view));
    console.log(`  预览: ${path.relative(ROOT, pv)}（红=描边处）`);
  }
}
console.log('\n掩码输出: assets\\build\\edges\\<组名>\\<帧名>（运行时按这个路径找）');
