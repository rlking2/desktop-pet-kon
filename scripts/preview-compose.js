// 把"成品帧 + 部件描边掩码"按**屏上真实尺寸**合成出来看一眼（renderer 的预览版）
//
// 用法: node scripts/preview-compose.js <组名> [<帧名>] [--width=1] [--depth=20] [--ring=1] [--zoom=3]
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const args = process.argv.slice(2);
const opt = { group: 'idle', frame: null, width: 1, depth: 20, ring: 1, zoom: 3 };
for (const a of args) {
  if (a.startsWith('--width=')) opt.width = Number(a.slice('--width='.length));
  else if (a.startsWith('--depth=')) opt.depth = Number(a.slice('--depth='.length));
  else if (a.startsWith('--ring=')) opt.ring = Number(a.slice('--ring='.length));
  else if (a.startsWith('--zoom=')) opt.zoom = Number(a.slice('--zoom='.length));
  else if (!a.startsWith('--')) {
    // 位置参数：先看是不是组名（assets/build/frames/<名字> 存在），否则当帧名过滤
    if (fs.existsSync(path.join(ASSETS, 'build', 'frames', a))) opt.group = a;
    else opt.frame = a;
  }
}

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
function resample(img, nw, nh) {
  const out = Buffer.alloc(nw * nh * 4);
  const sx = img.W / nw, sy = img.H / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.min(img.H, Math.ceil((y + 1) * sy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.min(img.W, Math.ceil((x + 1) * sx));
      let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * img.W + xx) * 4, a = img.rgba[i + 3];
        sr += img.rgba[i] * a; sg += img.rgba[i + 1] * a; sb += img.rgba[i + 2] * a; sa += a; n++;
      }
      const d = (y * nw + x) * 4;
      if (!n || sa === 0) { out[d + 3] = 0; continue; }
      out[d] = Math.round(sr / sa); out[d + 1] = Math.round(sg / sa); out[d + 2] = Math.round(sb / sa);
      out[d + 3] = Math.round(sa / n);
    }
  }
  return { W: nw, H: nh, rgba: out };
}

const framesDir = path.join(ASSETS, 'build', 'frames', opt.group);
const edgesDir = path.join(ASSETS, 'build', 'edges', opt.group);
const names = fs.readdirSync(framesDir).filter((x) => /\.png$/i.test(x)).sort();
const pick = opt.frame ? names.filter((n) => n.includes(opt.frame)) : names;
const DW = 167, DH = 200;
const Z = opt.zoom;
for (const name of pick) {
  const frame = decodePNG(fs.readFileSync(path.join(framesDir, name)));
  const edgePath = path.join(edgesDir, name);
  const edge = fs.existsSync(edgePath) ? decodePNG(fs.readFileSync(edgePath)) : null;
  const pad = opt.ring + 1;
  const scale = Math.min((DW - pad * 2) / frame.W, (DH - pad * 2) / frame.H);
  const fw = Math.max(1, Math.round(frame.W * scale)), fh = Math.max(1, Math.round(frame.H * scale));
  const f = resample(frame, fw, fh);
  const e = edge ? resample(edge, fw, fh) : null;
  const canvas = Buffer.alloc(DW * DH * 4);
  const ox = Math.round((DW - fw) / 2), oy = Math.round((DH - fh) / 2);
  const put = (x, y, r, g, b, a) => {
    if (x < 0 || y < 0 || x >= DW || y >= DH) return;
    const i = (y * DW + x) * 4, sa = a / 255, da = canvas[i + 3] / 255, oa = sa + da * (1 - sa);
    if (oa <= 0) return;
    canvas[i] = Math.round((r * sa + canvas[i] * da * (1 - sa)) / oa);
    canvas[i + 1] = Math.round((g * sa + canvas[i + 1] * da * (1 - sa)) / oa);
    canvas[i + 2] = Math.round((b * sa + canvas[i + 2] * da * (1 - sa)) / oa);
    canvas[i + 3] = Math.round(oa * 255);
  };
  const depth = Math.max(0, Math.min(255, opt.depth));
  if (opt.ring > 0) {
    for (let k = 0; k < 16; k++) {
      const a = (Math.PI * 2 * k) / 16;
      const dx = Math.round(Math.cos(a) * opt.ring), dy = Math.round(Math.sin(a) * opt.ring);
      for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
        if (f.rgba[(y * fw + x) * 4 + 3] < 40) continue;
        put(ox + x + dx, oy + y + dy, depth, depth, depth, 255);
      }
    }
  }
  for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
    const i = (y * fw + x) * 4;
    put(ox + x, oy + y, f.rgba[i], f.rgba[i + 1], f.rgba[i + 2], f.rgba[i + 3]);
  }
  if (e) {
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) {
      const i = (y * fw + x) * 4;
      if (e.rgba[i + 3] < 60) continue;
      for (let k = 0; k < 16; k++) {
        const a = (Math.PI * 2 * k) / 16;
        const dx = Math.round(Math.cos(a) * (opt.width - 1)) , dy = Math.round(Math.sin(a) * (opt.width - 1));
        put(ox + x + dx, oy + y + dy, depth, depth, depth, 255);
      }
    }
  }
  const OW = DW * Z, OH = DH * Z;
  const view = Buffer.alloc(OW * OH * 4);
  for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) {
    const i = (Math.floor(y / Z) * DW + Math.floor(x / Z)) * 4;
    const a = canvas[i + 3] / 255, d = (y * OW + x) * 4;
    view[d] = Math.round(canvas[i] * a + 255 * (1 - a));
    view[d + 1] = Math.round(canvas[i + 1] * a + 255 * (1 - a));
    view[d + 2] = Math.round(canvas[i + 2] * a + 255 * (1 - a));
    view[d + 3] = 255;
  }
  const out = path.join(ROOT, 'artifacts', `compose-${opt.group}-${name}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, encodePNG(OW, OH, view));
  console.log(`屏上合成: ${path.relative(ROOT, out)}  ${DW}x${DH}（${Z}x）线宽=${opt.width} 深度=${depth} 外轮廓=${opt.ring}`);
}
