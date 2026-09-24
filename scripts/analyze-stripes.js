// 分析条纹背景：找出背景到底由几种颜色组成、条纹方向与数量、能否可靠抠除。
// 用法: node scripts/analyze-stripes.js assets/1.png
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

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
      if (data[12] !== 0) throw new Error('隔行 PNG 暂不支持');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
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
  return { width, height, rgba: out, hasAlpha: colorType === 4 || colorType === 6 };
}

const file = process.argv[2] || path.join(__dirname, '..', 'assets', '1.png');
const img = decodePNG(fs.readFileSync(file));
const { width: W, height: H, rgba } = img;
console.log(`图: ${path.basename(file)}  ${W}x${H}  ${img.hasAlpha ? '有 alpha' : '无 alpha'}`);

const at = (x, y) => { const i = (y * W + x) * 4; return [rgba[i], rgba[i + 1], rgba[i + 2]]; };
const key = (c) => c.join(',');

// 1) 整体颜色直方图（量化到 8 级）
const hist = new Map();
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const c = at(x, y);
    const k = `${c[0] >> 3},${c[1] >> 3},${c[2] >> 3}`;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
}
const total = W * H;
const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([k, v]) => {
    const [r, g, b] = k.split(',').map((n) => (Number(n) << 3) + 4);
    return { rgb: `rgb(${r},${g},${b})`, pct: +(v / total * 100).toFixed(1) };
  });
console.log('\n主色分布（量化后前 10）:');
top.forEach((t) => console.log(`  ${t.rgb.padEnd(20)} ${t.pct}%`));

// 2) 逐行统计"最左一列 3 像素"的颜色 —— 判断条纹是横向带还是纵向带
console.log('\n逐行左侧 3px 平均色（每 12 行采样，看条纹边界）:');
const rowColors = [];
for (let y = 0; y < H; y++) {
  let r = 0, g = 0, b = 0;
  for (let x = 0; x < 3; x++) { const c = at(x, y); r += c[0]; g += c[1]; b += c[2]; }
  rowColors.push([Math.round(r / 3), Math.round(g / 3), Math.round(b / 3)]);
}
let changes = 0;
const bands = [];
let cur = rowColors[0], start = 0;
for (let y = 1; y < H; y++) {
  const d = Math.max(...[0, 1, 2].map((k) => Math.abs(rowColors[y][k] - cur[k])));
  if (d > 12) {
    bands.push({ from: start, to: y - 1, color: cur, h: y - start });
    cur = rowColors[y]; start = y; changes++;
  }
}
bands.push({ from: start, to: H - 1, color: cur, h: H - start });
console.log(`  检测到 ${bands.length} 条横向色带（变化点 ${changes} 个）`);
bands.slice(0, 20).forEach((b) => {
  console.log(`     y ${String(b.from).padStart(4)}~${String(b.to).padStart(4)} (高 ${String(b.h).padStart(3)})  rgb(${b.color.join(',')})`);
});
if (bands.length > 20) console.log(`     ...（共 ${bands.length} 条）`);

// 3) 背景色候选：出现最多的"带"颜色
const bandColors = new Map();
for (const b of bands) bandColors.set(key(b.color), (bandColors.get(key(b.color)) || 0) + b.h);
console.log('\n色带颜色统计（按总高度）:');
[...bandColors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  .forEach(([k, h]) => console.log(`  rgb(${k})  总高 ${h}px (${(h / H * 100).toFixed(0)}%)`));

// 4) 逐列统计（判断左右边缘有没有别的元素，比如那个粉色 A 标签）
const colColors = [];
for (let x = 0; x < W; x++) {
  let r = 0, g = 0, b = 0;
  for (let y = 0; y < 3; y++) { const c = at(x, y); r += c[0]; g += c[1]; b += c[2]; }
  colColors.push([Math.round(r / 3), Math.round(g / 3), Math.round(b / 3)]);
}
let cChanges = 0;
for (let x = 1; x < W; x++) {
  const d = Math.max(...[0, 1, 2].map((k) => Math.abs(colColors[x][k] - colColors[x - 1][k])));
  if (d > 12) cChanges++;
}
console.log(`\n顶部一行（y=0..2）横向颜色变化点: ${cChanges} 个 → ${cChanges < 5 ? '无明显竖向分割（背景是纯横条纹）' : '有竖向元素（可能是标签/装饰）'}`);
