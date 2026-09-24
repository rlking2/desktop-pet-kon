// 把 assets/ 里所有图片逐个列成一张表：是谁的、多大、有没有透明通道、能不能直接当桌宠形象用。
// 用法: node scripts/list-assets.js [路径片段]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');
const filter = process.argv[2] || '';

const MAGIC = [
  { name: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
  { name: 'GIF', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'WEBP', bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: 'BMP', bytes: [0x42, 0x4d] },
];

function sniff(p) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    for (const m of MAGIC) {
      if (m.bytes.every((b, i) => buf[i] === b)) {
        if (m.name === 'WEBP' && buf.toString('ascii', 8, 12) !== 'WEBP') continue;
        return m.name;
      }
    }
    return '未知';
  } catch { return '读不到'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// 读 PNG 头：尺寸 + 颜色类型（判断有没有 alpha 通道）
function pngInfo(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const head = Buffer.alloc(33);
    fs.readSync(fd, head, 0, 33, 0);
    return {
      width: head.readUInt32BE(16),
      height: head.readUInt32BE(20),
      bitDepth: head[24],
      colorType: head[25],
      hasAlpha: head[25] === 4 || head[25] === 6,
      interlaced: head[28] !== 0,
    };
  } finally { fs.closeSync(fd); }
}

// 抽样看 alpha 通道到底"用了没有"（全 255 = 实际没透明）
function alphaUsage(p, info) {
  try {
    const buf = fs.readFileSync(p);
    let pos = 8; const idat = [];
    while (pos < buf.length) {
      const len = buf.readUInt32BE(pos);
      const type = buf.toString('ascii', pos + 4, pos + 8);
      const data = buf.subarray(pos + 8, pos + 8 + len);
      if (type === 'IDAT') idat.push(data);
      else if (type === 'IEND') break;
      pos += 12 + len;
    }
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[info.colorType];
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = info.width * channels;
    // 全图网格抽样（每 4 像素取 1 个）——之前只抽上下各 64 行，
    // 结果裁剪过的图上下都是透明边缘，统计出来永远是"100% 透明"，数字没意义。
    const stepY = 4, stepX = 4;
    let transparent = 0, sampled = 0, minAlpha = 255, opaqueCore = 0;
    let prev = Buffer.alloc(stride);
    let rp = 0;
    for (let y = 0; y < info.height; y++) {
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
          const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
        }
        line[i] = v & 0xff;
      }
      prev = line;
      if (y % stepY !== 0) continue;
      for (let x = 0; x < info.width; x += stepX) {
        const a = line[x * channels + (channels - 1)];
        sampled++;
        if (a < 250) transparent++;
        if (a >= 250) opaqueCore++;
        if (a < minAlpha) minAlpha = a;
      }
    }
    return {
      sampled, transparent, transparentPct: +(transparent / sampled * 100).toFixed(1),
      opaquePct: +(opaqueCore / sampled * 100).toFixed(1), minAlpha,
    };
  } catch (err) {
    return { error: err.message };
  }
}

const rows = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full); continue; }
    const t = sniff(full);
    if (t === '未知' || t === '读不到') continue;
    const rel = path.relative(ASSETS, full);
    if (filter && !rel.includes(filter)) continue;
    const rec = { rel, real: t, ext: path.extname(e.name).replace('.', '').toLowerCase() || '(无)', sizeKB: +(fs.statSync(full).size / 1024).toFixed(0) };
    if (t === 'PNG') {
      const info = pngInfo(full);
      rec.dim = `${info.width}x${info.height}`;
      rec.hasAlpha = info.hasAlpha;
      rec.interlaced = info.interlaced;
      if (info.hasAlpha && !info.interlaced) {
        const au = alphaUsage(full, info);
        rec.transparentPct = au.transparentPct;
        rec.opaquePct = au.opaquePct;
        rec.minAlpha = au.minAlpha;
      }
    }
    rows.push(rec);
  }
}
walk(ASSETS);

console.log(`assets/ 下共 ${rows.length} 张图片${filter ? `（筛选 "${filter}"）` : ''}\n`);
console.log('文件'.padEnd(62) + '真身'.padEnd(6) + '扩展名'.padEnd(10) + '尺寸'.padEnd(12) + 'alpha'.padEnd(7) + '透明%'.padEnd(8) + '不透明%'.padEnd(9) + '判定');
console.log('-'.repeat(140));
let usable = 0, needKnockout = 0, noAlpha = 0;
for (const r of rows.sort((a, b) => a.rel.localeCompare(b.rel))) {
  let verdict;
  if (r.real !== 'PNG') { verdict = '❌ 格式不支持（只能解 PNG）'; }
  else if (!r.hasAlpha) { verdict = '❌ 无 alpha，必须先抠图'; noAlpha++; }
  else if (r.interlaced) { verdict = '❌ 隔行 PNG 暂不支持'; }
  else if (r.transparentPct < 1) { verdict = '❌ 有 alpha 但全不透明（背景没抠）'; needKnockout++; }
  else if (r.opaquePct < 2) { verdict = '⚠️ 几乎没有不透明像素（可能抠空了）'; }
  else { verdict = '✅ 可以'; usable++; }
  console.log(
    r.rel.padEnd(62) +
    r.real.padEnd(6) +
    ('.' + r.ext).padEnd(10) +
    (r.dim || '-').padEnd(12) +
    (r.hasAlpha === undefined ? '-' : (r.hasAlpha ? '有' : '无')).padEnd(7) +
    (r.transparentPct === undefined ? '-' : (r.transparentPct + '%')).padEnd(8) +
    (r.opaquePct === undefined ? '-' : (r.opaquePct + '%')).padEnd(9) +
    verdict
  );
}
console.log('-'.repeat(140));
console.log(`可直接使用: ${usable} 张   无 alpha 通道需抠图: ${noAlpha} 张   有通道但背景没抠: ${needKnockout} 张   合计 ${rows.length} 张`);
console.log('（透明%/不透明% 是全图 4x4 网格抽样，反映主体占画面多少）');
