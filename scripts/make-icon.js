// 生成安装包要用的图标：build-resources/icon.ico
//
// 为什么单独一个脚本：electron-builder 打 NSIS 安装包时需要一张**多尺寸 .ico**，
// 而那张图标的生成逻辑原本埋在 scripts/make-exe.js（便携版打包）里。
// 抽出来单独跑，两个打包方式都干净。
//
// 用法: node scripts/make-icon.js [成品帧.png]
//   默认取 assets/build/frames/idle/frame-000.png（角色本体，没有彩纸）
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'build-resources');
const SRC = path.resolve(ROOT, process.argv[2] || path.join('assets', 'build', 'frames', 'idle', 'frame-000.png'));

function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`不支持 ${data[8]}bit PNG`);
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') idat.push(data);
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
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[i] = v & 0xff;
    }
    prev = line;
    for (let x = 0; x < width; x++) {
      const s = x * ch, d = (y * width + x) * 4;
      if (ch === 4) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]; }
      else if (ch === 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
      else if (ch === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; }
      else { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]; }
    }
  }
  return { width, height, rgba: out };
}

// 找"最大的连通块"（角色本体，不含旁边飘的彩纸），图标要的是角色不是整张画布
function largestComponentBox(rgba, W, H, alphaMin = 40) {
  const label = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  let best = null;
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < alphaMin) continue;
    let sp = 0; stack[sp++] = start; label[start] = start;
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
        const ni = ny * W + nx;
        if (label[ni] !== -1 || rgba[ni * 4 + 3] < alphaMin) continue;
        label[ni] = label[start];
        if (sp < stack.length) stack[sp++] = ni;
      }
    }
    if (!best || count > best.count) best = { count, minX, minY, maxX, maxY };
  }
  return best;
}

// 方形取样 + 面积平均（alpha 加权，避免边缘发黑）
function sampleSquare(img, cx, cy, side, size) {
  const out = Buffer.alloc(size * size * 4);
  const { rgba, width: W, height: H } = img;
  const half = side / 2;
  for (let y = 0; y < size; y++) {
    const sy0 = cy - half + (y * side) / size, sy1 = cy - half + ((y + 1) * side) / size;
    for (let x = 0; x < size; x++) {
      const sx0 = cx - half + (x * side) / size, sx1 = cx - half + ((x + 1) * side) / size;
      let sumA = 0, sumR = 0, sumG = 0, sumB = 0, n = 0;
      const iy0 = Math.max(0, Math.floor(sy0)), iy1 = Math.min(H - 1, Math.ceil(sy1) - 1);
      const ix0 = Math.max(0, Math.floor(sx0)), ix1 = Math.min(W - 1, Math.ceil(sx1) - 1);
      for (let sy = iy0; sy <= iy1; sy++) {
        for (let sx = ix0; sx <= ix1; sx++) {
          const i = (sy * W + sx) * 4, a = rgba[i + 3];
          sumA += a; sumR += rgba[i] * a; sumG += rgba[i + 1] * a; sumB += rgba[i + 2] * a; n++;
        }
      }
      const d = (y * size + x) * 4;
      if (!n || sumA === 0) { out[d + 3] = 0; continue; }
      out[d] = Math.round(sumR / sumA);
      out[d + 1] = Math.round(sumG / sumA);
      out[d + 2] = Math.round(sumB / sumA);
      out[d + 3] = Math.round(sumA / n);
    }
  }
  return out;
}

// 32bpp DIB 图标条目：BITMAPINFOHEADER + 自下而上 BGRA + 全 0 的 AND 掩码
function dibEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, xor, Buffer.alloc(maskRow * size)]);
}

function makeIco(srcPng, outIco) {
  const img = decodePNG(fs.readFileSync(srcPng));
  const box = largestComponentBox(img.rgba, img.width, img.height) || { minX: 0, minY: 0, maxX: img.width - 1, maxY: img.height - 1 };
  const bw = box.maxX - box.minX + 1, bh = box.maxY - box.minY + 1;
  const cx = (box.minX + box.maxX + 1) / 2, cy = (box.minY + box.maxY + 1) / 2;
  const side = Math.max(bw, bh) * 1.12;
  const sizes = [256, 128, 64, 48, 32, 16];
  const images = sizes.map((s) => dibEntry(sampleSquare(img, cx, cy, side, s), s));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  sizes.forEach((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += images[i].length;
  });
  fs.writeFileSync(outIco, Buffer.concat([dir, ...entries, ...images]));
  return { bw, bh, sizes };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
if (!fs.existsSync(SRC)) {
  console.error(`❌ 找不到作图标的成品帧: ${SRC}（先跑素材构建 npm run exe 或 inspect-assets --write）`);
  process.exit(2);
}
const out = path.join(OUT_DIR, 'icon.ico');
const info = makeIco(SRC, out);
console.log(`图标: ${path.relative(ROOT, SRC)} → ${path.relative(ROOT, out)}`);
console.log(`      角色连通块 ${info.bw}x${info.bh}px，打包尺寸 ${info.sizes.join('/')}px 共 ${info.sizes.length} 档`);
