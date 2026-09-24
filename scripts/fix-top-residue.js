// 一次性修复：清理动作目录里所有帧的"左上角残留"，并给出可核对的证据。
//
// 背景（主人的反馈 + 人家查到的根因）：
//   - 主人说"7 还没消除"
//   - 根因：人家先 `copy cutout\7.png assets\idle\frame-01.png`，**后来**才清理 `cutout\7.png`，
//     没有回头同步 idle 里那份 → 对齐出来的帧仍然带残留。
//     （哈希对比：cutout/7.png = EF52...，idle/frame-01.png = 600A...，两份不一样）
//   - 而且人家第一次的清理矩形 (0,0,110,125) 偏小，没覆盖残留的真实范围。
//
// 本次策略（保守 + 可解释 + 留证据）：
//   1) 对每一帧，在"左上角象限"里量出残留包围盒，并按 6px 余量外扩
//   2) 密度检查：区域内不透明像素占比 > 25% 就拒绝（怕那是角色本体）
//   3) 清理前后都导出**同区域的放大预览图**，主人可以直接对比看变化
//
// 用法:
//   node scripts/fix-top-residue.js            # 只报告（默认）
//   node scripts/fix-top-residue.js --apply    # 执行清理
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const OUT = path.join(ROOT, 'artifacts', 'residue');
const ACTION_DIRS = ['idle', 'interact', 'hover'];
const APPLY = process.argv.includes('--apply');
// --file=<动作/文件名> --rect=x,y,w,h ：强制对某一帧执行指定矩形的清理
// （当自动判定不可靠、但已有密度图证据时使用；仍会做密度检查）
const onlyFile = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1] || null;
const forceRect = (() => {
  const a = process.argv.find((x) => x.startsWith('--rect='));
  if (!a) return null;
  const v = a.split('=')[1].split(',').map(Number);
  return v.length === 4 && v.every(Number.isFinite) ? v : null;
})();
const QW = 0.42, QH = 0.36;   // "左上角象限"的比例范围
const PAD = 6;               // 包围盒外扩
const DENSITY_LIMIT = 0.25;  // 密度上限，超过就拒绝

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

// 导出区域预览（放大 3 倍，最近邻）
function exportCrop(rgba, W, H, x0, y0, cw, ch, zoom, name) {
  const ow = cw * zoom, oh = ch * zoom;
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const sx = x0 + Math.floor(x / zoom), sy = y0 + Math.floor(y / zoom);
      const di = (y * ow + x) * 4;
      if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
      const si = (sy * W + sx) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, encodePNG(ow, oh, out));
  return path.relative(ROOT, p);
}

console.log(`清理动作目录左上角残留 ${APPLY ? '（执行）' : '（只报告，加 --apply 执行）'}\n`);
let cleaned = 0, refused = 0, cleanAlready = 0;
for (const d of ACTION_DIRS) {
  const dir = path.join(ASSETS, d);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir).filter((x) => /\.png$/i.test(x)).sort()) {
    const full = path.join(dir, f);
    const img = decodePNG(fs.readFileSync(full));
    const { width: W, height: H, rgba } = img;
    const label = `${d}/${f}`;
    if (onlyFile && label !== onlyFile) continue;

    // 强制矩形模式：跳过自动判定，直接用主人/开发者指定的矩形（仍做密度检查）
    if (forceRect) {
      const [fx, fy, fw, fh] = forceRect;
      let opaque = 0;
      for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) if (rgba[(y * W + x) * 4 + 3] >= 40) opaque++;
      const density = opaque / (fw * fh);
      console.log(`${label.padEnd(24)} ${String(W + 'x' + H).padEnd(12)} 强制矩形 (${fx},${fy}) ${fw}x${fh}  含内容 ${opaque}px  密度 ${(density * 100).toFixed(1)}%`);
      if (density > DENSITY_LIMIT) {
        console.log(`${''.padEnd(38)}❌ 密度 >${DENSITY_LIMIT * 100}%，拒绝（怕误删角色）`);
        const p1 = exportCrop(rgba, W, H, fx, fy, fw, fh, 3, `${d}-${f.replace(/\.png$/, '')}-REFUSED.png`);
        console.log(`${''.padEnd(38)}预览: ${p1}`);
        refused++;
        continue;
      }
      if (!APPLY) { console.log(`${''.padEnd(38)}（未执行，加 --apply）`); continue; }
      const before = exportCrop(rgba, W, H, fx, fy, fw, fh, 3, `${d}-${f.replace(/\.png$/, '')}-before.png`);
      for (let y = fy; y < fy + fh; y++) for (let x = fx; x < fx + fw; x++) rgba[(y * W + x) * 4 + 3] = 0;
      fs.writeFileSync(full, encodePNG(W, H, rgba));
      const afterImg = decodePNG(fs.readFileSync(full));
      const after = exportCrop(afterImg.rgba, W, H, fx, fy, fw, fh, 3, `${d}-${f.replace(/\.png$/, '')}-after.png`);
      console.log(`${''.padEnd(38)}✅ 已清理；对比图 before=${before}  after=${after}`);
      cleaned++;
      continue;
    }

    // 1) 量"角落装饰框"的范围：从 (0,0) 出发，逐行看"第一个不透明像素的 x"，直到该 x 距离左边界超过阈值
    //    —— 角落装饰框（编号/角标）总是紧贴左上角的**小方块**；
    //    角色本体不会紧贴左上角（抠图会留白），所以"第一个像素突然远离左边界"就是分界。
    const scanW = Math.round(W * QW);
    let boxMinX = W, boxMaxX = -1, boxMaxY = -1, scanRow = 0;
    for (let y = 0; y < Math.round(H * QH); y++) {
      let first = -1;
      for (let x = 0; x < scanW; x++) { if (rgba[(y * W + x) * 4 + 3] >= 40) { first = x; break; } }
      if (first < 0) continue;                       // 该行空
      if (first > 8 && boxMaxX >= 0) continue;        // 已经离左边太远 → 不是装饰框的一部分
      if (boxMaxX < 0 && first > 8) break;            // 从没找到过框，而第一个像素就离左边远 → 没有角落框
      scanRow = y;
      if (first < boxMinX) boxMinX = first;
      let last = first;
      for (let x = scanW - 1; x >= 0; x--) { if (rgba[(y * W + x) * 4 + 3] >= 40) { last = x; break; } }
      if (last > boxMaxX) boxMaxX = last;
      boxMaxY = y;
    }

    if (boxMaxX < 0) { console.log(`${label.padEnd(24)} ${String(W + 'x' + H).padEnd(12)} 左上角无紧贴内容 → 干净 ✅`); cleanAlready++; continue; }

    // 2) 清理矩形 = 框的范围 + 4px 余量
    const rx0 = 0, ry0 = 0;
    const rw = Math.min(scanW, boxMaxX + 1 + 4);
    const rh = Math.min(Math.round(H * QH), boxMaxY + 1 + 4);

    // 3) 密度检查 + "框内是否只有残留"的判定
    let opaque = 0, total = rw * rh;
    for (let y = ry0; y < rh; y++) for (let x = rx0; x < rw; x++) if (rgba[(y * W + x) * 4 + 3] >= 40) opaque++;
    const density = opaque / total;

    console.log(`${label.padEnd(24)} ${String(W + 'x' + H).padEnd(12)} 角落框 ${boxMaxX - boxMinX + 1}x${boxMaxY + 1}@(${boxMinX},0)`
      + `  里面 ${opaque}px`);
    console.log(`${''.padEnd(38)}清理矩形 (${rx0},${ry0}) ${rw}x${rh}  密度 ${(density * 100).toFixed(1)}%`);

    if (density > DENSITY_LIMIT) {
      console.log(`${''.padEnd(38)}❌ 密度过高，可能是角色本体 → 拒绝清理（请主人看图确认）`);
      const p1 = exportCrop(rgba, W, H, rx0, ry0, rw, rh, 3, `${d}-${f.replace(/\.png$/, '')}-REFUSED.png`);
      console.log(`${''.padEnd(38)}预览: ${p1}`);
      refused++;
      continue;
    }

    if (!APPLY) { console.log(`${''.padEnd(38)}（未执行，加 --apply）`); continue; }

    const before = exportCrop(rgba, W, H, rx0, ry0, rw, rh, 3, `${d}-${f.replace(/\.png$/, '')}-before.png`);
    for (let y = ry0; y < ry1; y++) for (let x = rx0; x < rx1; x++) rgba[(y * W + x) * 4 + 3] = 0;
    fs.writeFileSync(full, encodePNG(W, H, rgba));
    const afterImg = decodePNG(fs.readFileSync(full));
    const after = exportCrop(afterImg.rgba, W, H, rx0, ry0, rw, rh, 3, `${d}-${f.replace(/\.png$/, '')}-after.png`);
    console.log(`${''.padEnd(38)}✅ 已清理；对比图 before=${before}  after=${after}`);
    cleaned++;
  }
}
console.log(`\n干净 ${cleanAlready} 帧 / ${APPLY ? `已清理 ${cleaned} 帧` : `待清理 ${cleaned + (APPLY ? 0 : 0)} 帧`} / 拒绝 ${refused} 帧`);
if (APPLY && cleaned) {
  console.log('\n下一步（重新生成清单）：');
  for (const d of ACTION_DIRS) console.log(`  node scripts/inspect-assets.js ${d} --write --normalize-height`);
}
