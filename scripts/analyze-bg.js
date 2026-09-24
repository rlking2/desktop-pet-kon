// 抠图前置体检：判断每张图的"背景类型"，决定能不能自动抠。
//
// 为什么先体检：人家看不见图，只能靠统计特征判断。
// 背景类型决定抠图难度：
//   flat    四边颜色高度一致 → 自动抠很可靠
//   gradient 四边颜色渐变（比如影棚背景纸）→ 自动抠一般可行，需要更宽的容差
//   complex 四边颜色杂乱 → 几乎必然是真实场景照片，**自动抠会翻车**，必须手工/专业工具
//
// 用法: node scripts/analyze-bg.js [路径片段]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const filter = process.argv[2] || '';

function decodePNG(buf) {
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('隔行 PNG');
      if (bitDepth !== 8) throw new Error(bitDepth + 'bit');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), rp = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
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
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels >= 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; }
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
  }
  return { width, height, rgba: out, colorType, hasAlpha: colorType === 4 || colorType === 6 };
}

// 取四条边（每隔若干像素）的颜色样本
function edgeSamples(img, inset = 2) {
  const { width: W, height: H, rgba } = img;
  const s = [];
  const at = (x, y) => { const i = (y * W + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  const stepX = Math.max(1, Math.floor(W / 64));
  const stepY = Math.max(1, Math.floor(H / 64));
  for (let x = inset; x < W - inset; x += stepX) { s.push(at(x, inset)); s.push(at(x, H - 1 - inset)); }
  for (let y = inset; y < H - inset; y += stepY) { s.push(at(inset, y)); s.push(at(W - 1 - inset, y)); }
  return s;
}

function stats(nums) {
  const min = Math.min(...nums), max = Math.max(...nums);
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  const sd = Math.sqrt(nums.reduce((a, b) => a + (b - avg) ** 2, 0) / nums.length);
  return { min, max, avg: Math.round(avg), sd: +sd.toFixed(1), range: max - min };
}

function classify(img) {
  const s = edgeSamples(img);
  const r = stats(s.map((c) => c[0]));
  const g = stats(s.map((c) => c[1]));
  const b = stats(s.map((c) => c[2]));
  // 每通道的"离散度"：越小说明整圈边缘颜色越一致
  const spread = Math.max(r.sd, g.sd, b.sd);
  const range = Math.max(r.range, g.range, b.range);
  // 四角颜色互相之间的差异（判断"一圈是否一色"）
  const { width: W, height: H, rgba } = img;
  const corner = (x, y) => { const i = (y * W + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
  const corners = [corner(2, 2), corner(W - 3, 2), corner(2, H - 3), corner(W - 3, H - 3)];
  let cornerMaxDiff = 0;
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const d = Math.max(...[0, 1, 2].map((k) => Math.abs(corners[i][k] - corners[j][k])));
    if (d > cornerMaxDiff) cornerMaxDiff = d;
  }
  let type;
  if (spread <= 6 && cornerMaxDiff <= 14) type = 'flat';
  else if (spread <= 22 && cornerMaxDiff <= 60) type = 'gradient';
  else type = 'complex';
  return {
    type, spread, range, cornerMaxDiff,
    corners,
    mean: [r.avg, g.avg, b.avg],
    channels: { r, g, b },
  };
}

const files = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    const rel = path.relative(ASSETS, full);
    if (filter && !rel.includes(filter)) continue;
    // 按文件头判断，不看扩展名
    try {
      const fd = fs.openSync(full, 'r');
      const head = Buffer.alloc(4);
      fs.readSync(fd, head, 0, 4, 0);
      fs.closeSync(fd);
      if (head[0] === 0x89 && head[1] === 0x50) files.push(full);
    } catch { /* 跳过 */ }
  }
}
walk(ASSETS);

console.log(`分析 ${files.length} 张 PNG 的背景结构（人家看不见图，只能靠统计特征判断）\n`);
const VERDICT = {
  flat: '✅ 可自动抠（背景是一整片同色）',
  gradient: '⚠️ 可尝试自动抠（背景有渐变，需要较宽容差，建议人工确认）',
  complex: '❌ 不建议自动抠（背景复杂/是真实场景照片，自动抠会翻车）',
};
const rounds = { flat: 0, gradient: 0, complex: 0 };
for (const f of files.sort()) {
  const rel = path.relative(ASSETS, f);
  let img;
  try { img = decodePNG(fs.readFileSync(f)); }
  catch (err) { console.log(`${rel.padEnd(46)} 解码失败: ${err.message}`); continue; }
  const c = classify(img);
  rounds[c.type]++;
  console.log(`${rel.padEnd(46)} ${String(img.width + 'x' + img.height).padEnd(12)} ${c.hasAlpha ? '有alpha' : '无alpha'}  背景类型=${c.type.padEnd(9)} 边缘离散度=${String(c.spread).padEnd(6)} 四角色差=${String(c.cornerMaxDiff).padEnd(4)} 均值=rgb(${c.mean.join(',')})`);
  console.log(`${''.padEnd(46)} ${VERDICT[c.type]}`);
}
console.log(`\n汇总：flat ${rounds.flat} 张 / gradient ${rounds.gradient} 张 / complex ${rounds.complex} 张`);
