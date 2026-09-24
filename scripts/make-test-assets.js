// 生成合成测试素材：验证 inspect-assets.js 能正确处理散帧与精灵图、以及"尺寸不一致/残留白底"这类问题。
// 产物放在仓库根的 _fixtures/（不在 assets/ 里，避免被当成真素材）。
// 用法: node scripts/make-test-assets.js
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_fixtures');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
// 画一个"圆滚滚的蓝色家伙"，offset 用来制造帧间位移（模拟主体不居中的素材）
function drawBlob(W, H, cx, cy, r, rgb, opaqueBg) {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (opaqueBg) { buf[i] = 240; buf[i + 1] = 240; buf[i + 2] = 240; buf[i + 3] = 255; }
      if (d <= r) { buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = 255; }
      else if (d <= r + 1.5) { // 抗锯齿边缘
        const a = Math.round(255 * (1 - (d - r) / 1.5));
        buf[i] = rgb[0]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[2]; buf[i + 3] = a;
      }
    }
  }
  return buf;
}

fs.mkdirSync(path.join(OUT, 'idle'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'broken'), { recursive: true });

// 1) 正常序列：8 帧，主体上下浮动 + 尺寸略有变化（模拟呼吸）
const seqInfo = [];
for (let i = 0; i < 8; i++) {
  const W = 96, H = 96;
  const off = Math.round(Math.sin(i / 8 * Math.PI * 2) * 3);
  const r = 30 + Math.round(Math.sin(i / 8 * Math.PI * 2) * 1.5);
  const rgba = drawBlob(W, H, 48, 46 + off, r, [79, 182, 236], false);
  const name = `frame-${String(i + 1).padStart(2, '0')}.png`;
  fs.writeFileSync(path.join(OUT, 'idle', name), encodePNG(W, H, rgba));
  seqInfo.push({ name, W, H, cy: 46 + off });
}

// 2) 精灵图：4 列 x 2 行，每格 96x96（复用上面 8 帧的构图）
const COLS = 4, ROWS = 2, FW = 96, FH = 96;
const sheet = Buffer.alloc(FW * COLS * FH * ROWS * 4);
for (let i = 0; i < 8; i++) {
  const off = Math.round(Math.sin(i / 8 * Math.PI * 2) * 3);
  const r = 30 + Math.round(Math.sin(i / 8 * Math.PI * 2) * 1.5);
  const cell = drawBlob(FW, FH, 48, 46 + off, r, [79, 182, 236], false);
  const c = i % COLS, rr = Math.floor(i / COLS);
  for (let y = 0; y < FH; y++) {
    const ty = rr * FH + y;
    cell.copy(sheet, (ty * FW * COLS + c * FW) * 4, y * FW * 4, (y + 1) * FW * 4);
  }
}
fs.writeFileSync(path.join(OUT, 'sheet.png'), encodePNG(FW * COLS, FH * ROWS, sheet));
fs.writeFileSync(path.join(OUT, 'sheet.json'), JSON.stringify({ cols: COLS, rows: ROWS, frameWidth: FW, frameHeight: FH, defaultDelayMs: 110 }, null, 2));

// 3) 故意做坏的组：带不透明白底（模拟没抠图）+ 帧尺寸不一致 + 一帧全空
for (let i = 0; i < 3; i++) {
  const W = 90 + i * 10, H = 90;
  const rgba = drawBlob(W, H, W / 2, 45, 25, [79, 182, 236], true); // opaqueBg=true → 白底没抠
  fs.writeFileSync(path.join(OUT, 'broken', `bad-${i + 1}.png`), encodePNG(W, H, rgba));
}
fs.writeFileSync(path.join(OUT, 'broken', 'bad-4.png'), encodePNG(96, 96, Buffer.alloc(96 * 96 * 4))); // 全透明

console.log('已生成测试素材（仓库根 _fixtures/，不会被当成真素材）：');
console.log(`  _fixtures\\idle\\      ${seqInfo.length} 帧（正常序列）`);
console.log('  _fixtures\\sheet.png + sheet.json   4x2 精灵图');
console.log('  _fixtures\\broken\\    4 帧（故意做坏：白底未抠 / 尺寸不一 / 全空）');
