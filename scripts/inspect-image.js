// 截图结构分析：不依赖眼睛，用像素统计判断"画出来了没、画歪了没"
// 用法: node scripts/inspect-image.js [图片路径]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const file = process.argv[2] || path.join(__dirname, '..', 'artifacts', 'shot-latest.png');
const buf = fs.readFileSync(file);

// ---------- 极简 PNG 解码（只支持 Electron capturePage 输出的 8bit RGBA/非隔行） ----------
function decodePNG(b) {
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < b.length) {
    const len = b.readUInt32BE(pos);
    const type = b.toString('ascii', pos + 4, pos + 8);
    const data = b.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描');
      if (bitDepth !== 8) throw new Error('只支持 8bit');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const bb = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += bb;
      else if (filter === 3) v += (a + bb) >> 1;
      else if (filter === 4) {
        const p = a + bb - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - bb), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c);
      }
      line[i] = v & 0xff;
    }
    prev = line;
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels === 4) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]; }
      else if (channels === 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
      else if (channels === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]; }
    }
  }
  return { width, height, rgba: out };
}

const img = decodePNG(buf);
const { width: W, height: H, rgba } = img;

// ---------- 统计 ----------
const ALPHA_MIN = 16;
let opaque = 0;
let minX = W, minY = H, maxX = -1, maxY = -1;
const bins = {};      // 颜色粗分桶
const palette = [];   // 关键色命中
function near(r, g, b, t, tol = 46) {
  return Math.abs(r - t[0]) <= tol && Math.abs(g - t[1]) <= tol && Math.abs(b - t[2]) <= tol;
}
const KEYS = {
  hairBlue: [46, 88, 200],
  bodyBlue: [102, 191, 240],
  skin: [232, 247, 255],
  eyeNavy: [18, 58, 99],
  white: [255, 255, 255],
  blushPink: [255, 159, 191],
  debugRed: [255, 63, 111],
  orangeBeak: [255, 149, 0],
};
const hits = Object.fromEntries(Object.keys(KEYS).map((k) => [k, 0]));
let upperMass = 0, upperCount = 0, upperCX = 0;

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const a = rgba[i + 3];
    if (a < ALPHA_MIN) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    opaque++;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    const key = `${r >> 5},${g >> 5},${b >> 5}`;
    bins[key] = (bins[key] || 0) + 1;
    for (const [name, t] of Object.entries(KEYS)) if (near(r, g, b, t)) hits[name]++;
    if (y < H / 2) { upperMass += x; upperCount++; }
  }
}

const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
const coverage = +(opaque / (W * H)).toFixed(4);
const upperCXRatio = upperCount ? +((upperMass / upperCount) / W).toFixed(3) : null;

// 逐行不透明像素数（看轮廓形状：头小身大？还是整块方块？）
const rowProfile = [];
const STEP = Math.max(1, Math.floor(H / 24));
for (let y = 0; y < H; y += STEP) {
  let c = 0;
  for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3] >= ALPHA_MIN) c++;
  rowProfile.push({ y, ratio: +(c / W).toFixed(3) });
}

// ---------- 顶部菜单栏检测 ----------
// 无边框桌宠窗口不该出现菜单栏。若顶部若干行被不透明像素几乎整行填满，就是菜单栏挤进来了
// （会顶掉气泡位置、并在穿透掩码里凭空多出一条横带）。
const MENU_ROWS = Math.max(4, Math.round(H * 0.05));
let menuRowFull = 0;
for (let y = 0; y < MENU_ROWS; y++) {
  let c = 0;
  for (let x = 0; x < W; x++) if (rgba[(y * W + x) * 4 + 3] >= ALPHA_MIN) c++;
  if (c / W > 0.85) menuRowFull++;
}
const topPixel = { r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3] };

const topColors = Object.entries(bins).sort((a, b) => b[1] - a[1]).slice(0, 6)
  .map(([k, v]) => {
    const [r, g, b] = k.split(',').map((n) => (Number(n) << 5) + 16);
    return { rgb: `rgb(${r},${g},${b})`, share: +(v / opaque).toFixed(3) };
  });

const checks = [];
const push = (name, pass, detail) => checks.push({ name, pass, detail });

// 形状/配色类断言是给"具体主题形象"写的。两种情况下跳过：
//   1) 已接入素材（主人自己的形象，色卡与比例自然不适用）
//   2) 无素材（显示的是中性的"空位提示"环，同样没有主题配色可言）
let spriteMode = false;
let placeholderMode = false;
try {
  const sc = JSON.parse(fs.readFileSync(path.join(path.dirname(file), 'selfcheck.json'), 'utf8'));
  spriteMode = !!sc.spriteMode;
  placeholderMode = !!(sc.page && sc.page.sprite && sc.page.sprite.placeholder);
} catch { /* 没有自检数据就按主题形象检查 */ }

push('内容不贴边（留透明边距）', minX > 2 && minY > 2 && maxX < W - 3 && maxY < H - 3,
  `bbox=(${minX},${minY})-(${maxX},${maxY}) 画布=${W}x${H}`);
push('截图未被自检辅助线污染', hits.debugRed === 0, `debugRed=${hits.debugRed}（>0 说明红色边框层还开着）`);
push('顶部没有菜单栏（无边框窗口不该有）', menuRowFull === 0,
  `顶部 ${MENU_ROWS} 行中被填满的行数=${menuRowFull}；左上角像素=rgba(${topPixel.r},${topPixel.g},${topPixel.b},${topPixel.a})`);
// 主体占比断言：具体主题形象应在 15%~60%；空位提示环本身更小（约 8%~20%），另有下限
const covMin = placeholderMode ? 0.06 : 0.15;
push(`主体占比 ${(covMin * 100).toFixed(0)}%~60%`, coverage >= covMin && coverage <= 0.60,
  `coverage=${coverage}${placeholderMode ? '（空位提示模式，下限放宽）' : ''}`);
push('轮廓有起伏（不是方块）', new Set(rowProfile.map((r) => r.ratio)).size >= 4,
  `行宽分布去重=${new Set(rowProfile.map((r) => r.ratio)).size}`);

if (spriteMode) {
  console.log('（检测到帧动画模式：跳过"具体主题形象"的配色与形状断言）');
} else if (placeholderMode) {
  console.log('（检测到空位提示模式：当前没有接入素材，跳过配色与形状断言）');
} else {
  push('长发蓝在上半部分', hits.hairBlue > opaque * 0.02, `hairBlue=${hits.hairBlue} (${(hits.hairBlue / opaque * 100).toFixed(1)}%)`);
  push('身体浅蓝存在', hits.bodyBlue > opaque * 0.02, `bodyBlue=${hits.bodyBlue}`);
  push('脸部浅色存在', hits.skin > opaque * 0.02, `skin=${hits.skin}`);
  push('眼睛深蓝存在', hits.eyeNavy > 40, `eyeNavy=${hits.eyeNavy}`);
  push('腮红粉存在', hits.blushPink > 8, `blushPink=${hits.blushPink}`);
  push('主体重心偏右（尾部特征在右侧）', upperCXRatio !== null && upperCXRatio > 0.50, `上半部分水平重心=${upperCXRatio}`);
}

const report = {
  file: path.relative(path.join(__dirname, '..'), file),
  size: `${W}x${H}`,
  opaquePixels: opaque,
  coverage,
  bbox: { minX, minY, maxX, maxY, w: bboxW, h: bboxH },
  upperHalfCenterX: upperCXRatio,
  colorHits: hits,
  topColors,
  rowProfile,
  checks,
  passed: checks.filter((c) => c.pass).length,
  total: checks.length,
};
report.ok = report.passed === report.total;

const outJson = path.join(path.dirname(file), 'image-inspect.json');
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));

console.log(`\n===== 截图结构分析 ${report.file} (${report.size}) =====`);
console.log(`不透明像素 ${opaque} / 覆盖率 ${(coverage * 100).toFixed(1)}%  bbox ${bboxW}x${bboxH} @(${minX},${minY})`);
console.log(`上半部分水平重心 x=${upperCXRatio}（>0.5 说明主体重心偏右）`);
console.log('主色: ' + report.topColors.map((c) => `${c.rgb} ${(c.share * 100).toFixed(0)}%`).join(' | '));
console.log('--- 断言 ---');
for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
console.log(`===== ${report.passed}/${report.total} ${report.ok ? '✅' : '❌'}  → ${path.relative(process.cwd(), outJson)} =====\n`);

process.exit(report.ok ? 0 : 2);
