// 清理"左上角编号框"（最保守的判据）
//
// 主人这批素材的编号框（手写数字 + 虚线方框）**全部位于左上角**，
// 而角色主体都从更低、更右的位置开始。所以最可靠的判据是：
//   1) 找到"主体起点" = 第一行满足"该行内容宽度 >= 图像宽度 25%"的行
//      （编号框是细线/稀疏结构，永远达不到 25% 宽度；主体一开始就很宽）
//   2) 在"左上角区域（左侧 40% 宽）里、y < 主体起点"的内容，全部清掉
//   3) 安全校验：清理区域密度必须低于阈值；且主体起点必须 > 40（太靠上就放弃）
//
// 为什么不用"稀疏/贴边/长宽比"那套：实测会把角色身上的小装饰也判成残留
// （比如 idle/frame-02 的 @(759,1301)、idle/frame-03 的 @(604,1025)），
// 那比留着残留更糟。
//
// 用法:
//   node scripts/clean-corner-frames.js            # 只报告
//   node scripts/clean-corner-frames.js --apply    # 执行
//   node scripts/clean-corner-frames.js --only=idle/frame-02.png --apply
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'artifacts', 'residue');
const APPLY = process.argv.includes('--apply');
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || null;
const ALPHA_MIN = 40;
const WIDTH_THRESHOLD = 0.25;  // "该行内容宽度 >= 图像宽度的 25%" 视为主体开始
const REGION_W = 0.40;         // 只清理左侧 40% 宽
const DENSITY_LIMIT = 0.20;    // 清理区域密度上限
const MIN_SUBJECT_START = 40;  // 主体起点小于此值则放弃（怕误删）

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

console.log(`清理左上角编号框（保守判据）${APPLY ? ' —— 执行' : ' —— 只报告，加 --apply 执行'}`);
console.log(`判据: 主体起点 = 首个"行内容宽度 >= ${(WIDTH_THRESHOLD * 100).toFixed(0)}%图像宽"的行；`
  + `清理 左侧${(REGION_W * 100).toFixed(0)}%宽 x 主体起点 以上 的内容\n`);

let cleaned = 0, skipped = 0;
for (const d of ['idle', 'interact', 'hover']) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    const rel = `${d}/${f}`;
    if (ONLY && rel !== ONLY) continue;
    const full = path.join(dir, f);
    const img = decodePNG(fs.readFileSync(full));
    const { width: W, height: H, rgba } = img;

    // 1) 逐行的"内容宽度"（最右 - 最左）
    let subjectStart = -1;
    for (let y = 0; y < H; y++) {
      let minX = -1, maxX = -1;
      for (let x = 0; x < W; x++) {
        if (rgba[(y * W + x) * 4 + 3] >= ALPHA_MIN) { if (minX < 0) minX = x; maxX = x; }
      }
      if (minX < 0) continue;
      if (maxX - minX + 1 >= W * WIDTH_THRESHOLD) { subjectStart = y; break; }
    }

    const label = rel.padEnd(22) + `${W}x${H}`.padEnd(11);
    if (subjectStart < 0) { console.log(`${label}未找到主体起点（可能主体很窄）→ 跳过`); skipped++; continue; }
    if (subjectStart < MIN_SUBJECT_START) {
      console.log(`${label}主体起点 y=${subjectStart} < ${MIN_SUBJECT_START} → 太靠上，跳过（怕误删）`);
      skipped++; continue;
    }

    // 2) 清理矩形：左侧 REGION_W 宽 × 主体起点以上
    const rw = Math.round(W * REGION_W), rh = subjectStart;
    let opaque = 0;
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (rgba[(y * W + x) * 4 + 3] >= ALPHA_MIN) opaque++;
    const density = opaque / (rw * rh);

    console.log(`${label}主体起点 y=${subjectStart}   清理矩形 (0,0) ${rw}x${rh}   其中内容 ${opaque}px 密度 ${(density * 100).toFixed(1)}%`);

    if (density > DENSITY_LIMIT) {
      console.log(`${''.padEnd(33)}❌ 密度 > ${(DENSITY_LIMIT * 100).toFixed(0)}%，拒绝（可能含主体）`);
      skipped++;
      continue;
    }
    if (opaque === 0) { console.log(`${''.padEnd(33)}✅ 该区域本来就空`); continue; }
    if (!APPLY) { console.log(`${''.padEnd(33)}（未执行）`); continue; }

    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) rgba[(y * W + x) * 4 + 3] = 0;
    fs.writeFileSync(full, encodePNG(W, H, rgba));
    console.log(`${''.padEnd(33)}✅ 已清掉 ${opaque}px`);
    cleaned++;
  }
}
console.log(`\n${APPLY ? `已清理 ${cleaned} 帧` : '未执行'} / 跳过 ${skipped} 帧`);
if (APPLY && cleaned) {
  console.log('\n下一步：重新生成清单');
  for (const d of ['idle', 'interact', 'hover']) console.log(`  node scripts/inspect-assets.js ${d} --write --normalize-height`);
}
