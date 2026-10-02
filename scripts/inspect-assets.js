// 素材探测器：不靠眼睛看图，用像素统计把"这套图能不能用"讲清楚。
//
// 支持两种输入：
//   1) 散帧 PNG 序列：assets/<组名>/*.png（按文件名排序当作帧序）
//   2) 精灵图 spritesheet：assets/<组名>.png + assets/<组名>.json（描述 cols/rows/frameWidth/frameHeight）
//
// 为什么需要它：桌宠是逐像素穿透 + 自动自检的程序，素材一旦"尺寸不一致 / 没有 alpha 通道 /
// 帧间跳动"，后面会连锁出问题（穿透错位、动画抖动）。所以进来先体检。
//
// 用法:
//   node scripts/inspect-assets.js                 # 体检 assets/ 下所有素材组
//   node scripts/inspect-assets.js <组名>          # 只体检某组
//   node scripts/inspect-assets.js --write         # 顺手生成 manifest.json（含对齐偏移与统一画布）

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
const ALPHA_MIN = 16;
// 帧延时基准与速度倍率。
// 主人用临时调速滑条试出的速度是 0.49×；按 100ms 基准换算 → 每帧 204ms。
// 想再调速度时改这两个数即可（延时 = BASE_DELAY_MS / SPEED_MULTIPLIER）。
const BASE_DELAY_MS = 100;
const SPEED_MULTIPLIER = 0.49;

// ---------- PNG 解码（8bit，非隔行，支持 RGBA/RGB/灰度） ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描 PNG');
      if (bitDepth !== 8) throw new Error(`不支持 ${bitDepth}bit PNG（需要 8bit）`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('不支持的颜色类型 ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride), rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = Buffer.from(raw.subarray(rp, rp + stride));
    rp += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
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
  return { width, height, rgba: out, hasAlphaChannel: colorType === 4 || colorType === 6 };
}

// ---------- 单帧统计 ----------
function analyzeFrame(img) {
  const { width: W, height: H, rgba } = img;
  let minX = W, minY = H, maxX = -1, maxY = -1, opaque = 0;
  let partial = 0; // 半透明像素数（抗锯齿边缘）
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const a = rgba[(y * W + x) * 4 + 3];
      if (a >= ALPHA_MIN) {
        opaque++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (a > 0 && a < 250) partial++;
    }
  }
  const fullOpaque = (() => { // 完全不透明的像素（可能是白色背景没抠干净）
    let c = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) c++;
    return c;
  })();
  return {
    width: W, height: H, opaque,
    hasAlphaChannel: img.hasAlphaChannel,
    coverage: +(opaque / (W * H)).toFixed(4),
    // 「整帧不透明占比」= alpha≥16 的像素比例。接近 1 说明背景没抠掉（多半是白底残留）
    opaqueRatio: +(opaque / (W * H)).toFixed(4),
    fullOpaqueRatio: +(fullOpaque / (W * H)).toFixed(4),
    partialRatio: +(partial / (W * H)).toFixed(4),
    bbox: maxX < 0 ? null : { minX, minY, maxX, maxY, w: maxX - minX + 1, h: maxY - minY + 1 },
  };
}

// 双线性缩放（带 alpha 加权，避免透明边缘发灰）
function scaleBilinear(rgba, W, H, scale) {
  const nw = Math.max(1, Math.round(W * scale));
  const nh = Math.max(1, Math.round(H * scale));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) / scale - 0.5;
    const y0 = Math.max(0, Math.min(H - 1, Math.floor(sy)));
    const y1 = Math.min(H - 1, y0 + 1);
    const fy = Math.max(0, Math.min(1, sy - Math.floor(sy)));
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) / scale - 0.5;
      const x0 = Math.max(0, Math.min(W - 1, Math.floor(sx)));
      const x1 = Math.min(W - 1, x0 + 1);
      const fx = Math.max(0, Math.min(1, sx - Math.floor(sx)));
      const i00 = (y0 * W + x0) * 4, i01 = (y0 * W + x1) * 4;
      const i10 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
      const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy;
      const a00 = rgba[i00 + 3] / 255, a01 = rgba[i01 + 3] / 255;
      const a10 = rgba[i10 + 3] / 255, a11 = rgba[i11 + 3] / 255;
      const aSum = w00 * a00 + w01 * a01 + w10 * a10 + w11 * a11;
      const di = (y * nw + x) * 4;
      if (aSum <= 0.0001) { out[di + 3] = 0; continue; }
      out[di] = Math.round((rgba[i00] * w00 * a00 + rgba[i01] * w01 * a01 + rgba[i10] * w10 * a10 + rgba[i11] * w11 * a11) / aSum);
      out[di + 1] = Math.round((rgba[i00 + 1] * w00 * a00 + rgba[i01 + 1] * w01 * a01 + rgba[i10 + 1] * w10 * a10 + rgba[i11 + 1] * w11 * a11) / aSum);
      out[di + 2] = Math.round((rgba[i00 + 2] * w00 * a00 + rgba[i01 + 2] * w01 * a01 + rgba[i10 + 2] * w10 * a10 + rgba[i11 + 2] * w11 * a11) / aSum);
      out[di + 3] = Math.round(aSum * 255);
    }
  }
  return { rgba: out, w: nw, h: nh };
}

// 把一帧按偏移画进统一画布
function blitTo(dst, dstW, dstH, src, srcW, srcH, offX, offY) {
  for (let y = 0; y < srcH; y++) {
    const ty = y + offY;
    if (ty < 0 || ty >= dstH) continue;
    for (let x = 0; x < srcW; x++) {
      const tx = x + offX;
      if (tx < 0 || tx >= dstW) continue;
      const si = (y * srcW + x) * 4, di = (ty * dstW + tx) * 4;
      const a = src[si + 3];
      if (a === 0) continue;
      if (a === 255) {
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255;
      } else {
        // 简单按 alpha 覆盖（源在上）
        const sa = a / 255;
        dst[di] = Math.round(src[si] * sa + dst[di] * (1 - sa));
        dst[di + 1] = Math.round(src[si + 1] * sa + dst[di + 1] * (1 - sa));
        dst[di + 2] = Math.round(src[si + 2] * sa + dst[di + 2] * (1 - sa));
        dst[di + 3] = Math.max(dst[di + 3], a);
      }
    }
  }
}

function encodePNG(W, H, rgba) {
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0; // filter 0
    rgba.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }
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
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 判断"这是不是一张图"：看文件头，不看扩展名 ----------
// 实际踩到的坑：主人放进来的文件叫 `xxx.jpg-lx2`，**扩展名不是 .png，内容却是真 PNG**
// （从 Live2D / 游戏资源包里扒出来的常见命名）。只按扩展名筛会整批漏掉。
const MAGIC = [
  { name: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { name: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { name: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { name: 'webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { name: 'bmp', bytes: [0x42, 0x4d] },
];

function sniffImageType(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    if (n < 4) return null;
    for (const m of MAGIC) {
      if (m.bytes.every((b, i) => buf[i] === b)) {
        if (m.name === 'webp' && buf.toString('ascii', 8, 12) !== 'WEBP') return null;
        return m.name;
      }
    }
    return null;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// 当前解码器只支持 8bit 非隔行 PNG
function isUsableImage(filePath) {
  return sniffImageType(filePath) === 'png';
}

// 判断一张图是不是精灵图：必须存在同名 .json（扩展名无关），且 json 里有 cols/rows/frameWidth/frameHeight
function readSheetMeta(pngPath) {
  const jsonPath = pngPath.replace(/\.[^.]+$/, '.json');
  if (!fs.existsSync(jsonPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const ok = ['cols', 'rows', 'frameWidth', 'frameHeight'].every((k) => typeof meta[k] === 'number' && meta[k] > 0);
    return ok ? { jsonPath, meta } : null;
  } catch { return null; }
}

function loadGroups() {
  if (!fs.existsSync(ASSETS)) return { groups: [], loose: [] };
  const groups = [];
  const loose = [];

  // 扫描一个目录：先认"目录里的精灵图"，再把散帧收成序列、把单图收成"单帧素材"
  // 注意：一律用文件头判断是不是图（不认扩展名）——实测有 `xxx.jpg-lx2` 其实是 PNG
  function scanDir(dir, label, depth) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const imageFiles = entries.filter((e) => e.isFile() && isUsableImage(path.join(dir, e.name))).map((e) => e.name);

    // 1) 目录里带 json 描述的精灵图
    const sheetFiles = new Set();
    for (const name of imageFiles) {
      const full = path.join(dir, name);
      const sheet = readSheetMeta(full);
      if (sheet) {
        sheetFiles.add(name);
        const base = name.replace(/\.[^.]+$/, '');
        groups.push({ name: label ? `${label}/${base}` : base, kind: 'spritesheet', file: full, jsonPath: sheet.jsonPath });
      }
    }

    const rest = imageFiles.filter((n) => !sheetFiles.has(n)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    // 2) 目录里的散帧序列（**1 帧也算**：主人可能只用一张图做"鼠标靠近"这种动作）。
    //    ⚠️ 踩坑：这里必须 `files: rest.slice()`，不能直接传 `rest` 再 `rest.length = 0` ——
    //    后者清空的是**同一个数组对象**，组里的 files 会被一起清空（files[0] 变 undefined），
    //    症状是 "The path argument must be of type string. Received undefined"。
    if (label && rest.length > 0) {
      groups.push({ name: label, kind: 'sequence', dir, files: rest.slice() });
      rest.length = 0;
    }

    // 3) 剩下的单张图：作为"单帧素材"也要报告出来，而不是静默忽略
    for (const name of rest) {
      const base = name.replace(/\.[^.]+$/, '');
      const full = path.join(dir, name);
      groups.push({ name: label ? `${label}/${base}` : base, kind: 'single', file: full });
    }

    // 4) 子目录（最多两层）。跳过：
    //    - 下划线开头：内部测试夹具
    //    - build：生成产物
    //    - cutout：抠图成品（是"挑图的素材源"，不是动作组；否则 13 张会被当成一个大序列混进来）
    const SKIP_DIRS = new Set(['build', 'cutout']);
    if (depth < 2) {
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('_') || SKIP_DIRS.has(e.name)) continue;
        scanDir(path.join(dir, e.name), label ? `${label}/${e.name}` : e.name, depth + 1);
      }
    }
  }

  scanDir(ASSETS, '', 0);
  if (process.env.DEBUG_GROUPS === '1') {
    console.log('[调试] 扫描到的素材组: ' + JSON.stringify(groups.map((g) => ({
      name: g.name, kind: g.kind, dir: g.dir, files: g.files && g.files.length, file: g.file,
    })), null, 2));
  }
  return { groups, loose };
}

function inspectGroup(group, opts) {
  const result = { name: group.name, kind: group.kind, frames: [], problems: [], warnings: [] };
  let sheetMeta = null;
  if (group.kind === 'spritesheet') {
    sheetMeta = JSON.parse(fs.readFileSync(group.jsonPath, 'utf8'));
  }

  const fileList = group.kind === 'sequence'
    ? group.files.map((f) => path.join(group.dir, f))
    : [group.file];

  let sheet = null;
  if (group.kind === 'spritesheet') {
    sheet = decodePNG(fs.readFileSync(group.file));
    result.sheet = { width: sheet.width, height: sheet.height, ...sheetMeta };
    if (!sheetMeta) throw new Error(`精灵图 ${group.name} 缺少 ${group.name}.json 描述文件`);
    const { cols, rows, frameWidth, frameHeight } = { ...sheetMeta };
    if (!cols || !rows || !frameWidth || !frameHeight) throw new Error('json 需要 cols/rows/frameWidth/frameHeight');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const sub = Buffer.alloc(frameWidth * frameHeight * 4);
        for (let y = 0; y < frameHeight; y++) {
          const sy = r * frameHeight + y;
          if (sy >= sheet.height) break;
          for (let x = 0; x < frameWidth; x++) {
            const sx = c * frameWidth + x;
            if (sx >= sheet.width) break;
            const si = (sy * sheet.width + sx) * 4, di = (y * frameWidth + x) * 4;
            sub[di] = sheet.rgba[si]; sub[di + 1] = sheet.rgba[si + 1];
            sub[di + 2] = sheet.rgba[si + 2]; sub[di + 3] = sheet.rgba[si + 3];
          }
        }
        const img = { width: frameWidth, height: frameHeight, rgba: sub };
        result.frames.push({ index: r * cols + c, file: `${group.name}.png[${r},${c}]`, ...analyzeFrame(img), _img: img });
      }
    }
  } else {
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      try {
        const img = decodePNG(fs.readFileSync(f));
        result.frames.push({ index: i, file: path.basename(f), ...analyzeFrame(img), _img: img });
      } catch (err) {
        result.problems.push(`第 ${i} 帧 ${path.basename(f)} 解码失败: ${err.message}`);
      }
    }
  }

  // ---- 文件格式体检：内容真身 vs 扩展名 ----
  // 实测教训：主人放进来的一批文件叫 `xxx.jpg-lx2`，**扩展名不是 .png 但内容是真 PNG**。
  // 只按扩展名筛会整批漏掉；只按内容认又会让主人困惑，所以两边都报出来。
  const sample = group.kind === 'sequence' ? path.join(group.dir, group.files[0])
    : group.kind === 'spritesheet' ? group.file : group.file;
  const realType = sniffImageType(sample);
  const declaredExt = path.extname(sample).toLowerCase().replace('.', '');
  result.format = { sample: path.basename(sample), realType, declaredExt };
  if (realType && realType !== declaredExt) {
    result.warnings.push(`内容真身是 ${realType.toUpperCase()}，但扩展名是 ".${declaredExt}"（或带后缀）`
      + ' → 已按内容识别，不影响使用；若要让工具更省事可以改名');
  }
  if (group.kind === 'single') {
    result.warnings.push('这是单张图（不是序列/精灵图）→ 只能当作一帧静态形象使用');
  }

  if (!result.frames.length) {
    result.problems.push('没有可用帧');
    return result;
  }

  // ---- 体检项 ----
  const sizes = new Set(result.frames.map((f) => `${f.width}x${f.height}`));
  if (sizes.size > 1) {
    result.warnings.push(`帧尺寸不一致（${[...sizes].join(', ')}）→ 生成清单时会自动对齐到统一画布`);
  }
  const noAlphaChannel = result.frames.filter((f) => f.hasAlphaChannel === false);
  if (noAlphaChannel.length) {
    result.problems.push(`${noAlphaChannel.length} 帧的 PNG 没有 alpha 通道（第 ${noAlphaChannel.map((f) => f.index).join(',')} 帧）`
      + ' → 桌宠会变成一个方块，必须先抠掉背景再导出带透明通道的 PNG');
  }
  // 有 alpha 通道但背景没抠干净：整帧几乎全不透明
  const fullBg = result.frames.filter((f) => f.hasAlphaChannel !== false && f.opaqueRatio > 0.97);
  if (fullBg.length) {
    result.problems.push(`${fullBg.length} 帧几乎整帧不透明（第 ${fullBg.map((f) => f.index).join(',')} 帧）`
      + ' → 背景没抠干净（残留了整块背景色），要么重新抠图，要么这组图不能直接用');
  }
  const empty = result.frames.filter((f) => f.opaque < 20);
  if (empty.length) result.problems.push(`${empty.length} 帧几乎是空的（第 ${empty.map((f) => f.index).join(',')} 帧）`);

  const covs = result.frames.map((f) => f.coverage);
  const covMin = Math.min(...covs), covMax = Math.max(...covs);
  if (covMax - covMin > 0.25) {
    result.warnings.push(`帧间主体面积波动大（${(covMin * 100).toFixed(1)}% ~ ${(covMax * 100).toFixed(1)}%）→ 可能是不同动作混在一组`);
  }

  if (result.frames[0].bbox) {
    const ws = result.frames.map((f) => f.bbox && f.bbox.w).filter(Boolean);
    const hs = result.frames.map((f) => f.bbox && f.bbox.h).filter(Boolean);
    result.contentSize = { wMin: Math.min(...ws), wMax: Math.max(...ws), hMin: Math.min(...hs), hMax: Math.max(...hs) };
  }

  // ---- 生成对齐后的清单 ----
  const pad = 2;
  const canvasW = Math.max(...result.frames.map((f) => f.bbox ? f.bbox.w : 0)) + pad * 2;
  const canvasH = Math.max(...result.frames.map((f) => f.bbox ? f.bbox.h : 0)) + pad * 2;
  result.canvas = { width: canvasW, height: canvasH };

  // 主体尺寸一致性检查：真人照片/多角度素材常见"每张拍的距离不一样"，
  // 直接按包围盒对齐会导致播放时**人物忽大忽小**。
  const bboxWs = result.frames.map((f) => (f.bbox ? f.bbox.w : 0)).filter(Boolean);
  const bboxHs = result.frames.map((f) => (f.bbox ? f.bbox.h : 0)).filter(Boolean);
  const sizeRatio = bboxHs.length ? +(Math.max(...bboxHs) / Math.min(...bboxHs)).toFixed(2) : 1;
  result.sizeRatio = sizeRatio;
  if (sizeRatio > 1.15) {
    result.warnings.push(`主体高度相差 ${sizeRatio} 倍（${Math.min(...bboxHs)}~${Math.max(...bboxHs)}px）`
      + ' → 直接播放会"忽大忽小"；用 --normalize-height 按主体高度统一（人家推荐）');
  }

  result.aligned = result.frames.map((f) => {
    // 以"内容包围盒"对齐：每帧主体贴到画布中心（避免原图四周留白不一致导致抖动）
    const offX = f.bbox ? Math.round((canvasW - f.bbox.w) / 2 - f.bbox.minX) : 0;
    const offY = f.bbox ? Math.round((canvasH - f.bbox.h) / 2 - f.bbox.minY) : 0;
    // 统一主体大小时，每帧缩放到 **全局目标高度**（opts.targetHeight）。
    // ⚠️ 必须是"全局"而不是"组内最高那帧"：三组素材各自取组内最高会导致
    //    idle 与 hover 的角色大小对不上，鼠标一靠近人物就突然变大/变小。
    const target = opts.targetHeight || (bboxHs.length ? Math.max(...bboxHs) : 0);
    const scale = (opts.normalizeHeight && f.bbox && target) ? target / f.bbox.h : 1;
    return { index: f.index, file: f.file, offsetX: offX, offsetY: offY, scale: +scale.toFixed(4) };
  });

  if (opts.write) {
    // 产物统一放 assets/build/frames/<组名>/，既不会污染素材组，也不会被扫描器当成新素材
    const safeName = group.name.replace(/[\\/]/g, '__');
    const framesDir = path.join(ASSETS, 'build', 'frames', safeName);
    // ⚠️ 必须先清空这个目录再写：帧数变少时（比如 3 帧的动作换成 1 张定格图），
    //    旧的 frame-001/frame-002 会留在磁盘上。虽然清单里不引用它们（不影响播放），
    //    但目录看着像"还有 3 帧"，而且会被一起打进便携包。踩过一次，这里直接清干净。
    if (fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir, { recursive: true });
    const written = [];
    for (const f of result.frames) {
      const a = result.aligned.find((x) => x.index === f.index);
      // 需要统一主体大小时，先把这一帧按 scale 缩放（双线性，保清晰度），再贴到统一画布
      let srcRgba = f._img.rgba, srcW = f.width, srcH = f.height;
      let offX = a.offsetX, offY = a.offsetY;
      if (a.scale && Math.abs(a.scale - 1) > 0.001) {
        const scaled = scaleBilinear(f._img.rgba, f.width, f.height, a.scale);
        // 缩放后主体位置跟着变：以包围盒左上角为锚点重算偏移
        offX = Math.round((canvasW - (f.bbox ? f.bbox.w * a.scale : scaled.w)) / 2 - (f.bbox ? f.bbox.minX * a.scale : 0));
        offY = Math.round((canvasH - (f.bbox ? f.bbox.h * a.scale : scaled.h)) / 2 - (f.bbox ? f.bbox.minY * a.scale : 0));
        srcRgba = scaled.rgba; srcW = scaled.w; srcH = scaled.h;
      }
      const canvas = Buffer.alloc(canvasW * canvasH * 4);
      blitTo(canvas, canvasW, canvasH, srcRgba, srcW, srcH, offX, offY);
      const name = `frame-${String(f.index).padStart(3, '0')}.png`;
      fs.writeFileSync(path.join(framesDir, name), encodePNG(canvasW, canvasH, canvas));
      written.push(name);
    }
    // 每帧延时 = 基准 ÷ 速度倍率。主人用临时调速滑条试出的速度是 0.49×，
    // 按 100ms 基准换算 → 204ms/帧（100 ÷ 0.49 ≈ 204）。
    // 想再调速度：改上面两个常量后重新跑 --write 即可。
    const frameDelay = Math.round(BASE_DELAY_MS / SPEED_MULTIPLIER);
    const groupEntry = {
      canvas: { width: canvasW, height: canvasH },
      defaultDelayMs: frameDelay,
      speedMultiplier: SPEED_MULTIPLIER,   // 记录倍率与基准，方便以后换算
      baseDelayMs: BASE_DELAY_MS,
      frames: written.map((name, i) => ({
        file: path.relative(ASSETS, path.join(framesDir, name)).replace(/\\/g, '/'),
        delayMs: frameDelay,
        index: i,
      })),
    };
    // ★ 合并成 assets/manifest.json（运行时只读这一份，能同时容纳多个动作组）
    const mergedPath = path.join(ASSETS, 'manifest.json');
    let merged = { groups: {} };
    if (fs.existsSync(mergedPath)) {
      try {
        const prev = JSON.parse(fs.readFileSync(mergedPath, 'utf8'));
        merged = prev.groups ? prev : { groups: { [prev.group || 'idle']: prev } };
      } catch { merged = { groups: {} }; }
    }
    merged.groups[group.name] = groupEntry;
    merged.generatedAt = new Date().toISOString();
    fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

    result.wrote = {
      framesDir: path.relative(ROOT, framesDir),
      manifest: path.relative(ROOT, mergedPath),
      count: written.length,
      groups: Object.keys(merged.groups),
    };
  }

  // 去掉大对象，避免打印时爆炸
  result.frames = result.frames.map(({ _img, ...rest }) => rest);
  return result;
}

// ---------- 主流程 ----------
const args = process.argv.slice(2);
const write = args.includes('--write');
// --normalize-height：按主体高度统一各帧（真人照片/多角度素材常"每张拍的距离不同"，
// 不做这一步播放时会忽大忽小）
const normalizeHeight = args.includes('--normalize-height');
const only = args.find((a) => !a.startsWith('--'));

if (!fs.existsSync(ASSETS)) {
  fs.mkdirSync(ASSETS, { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'README.txt'),
    '把素材放这里：\r\n' +
    '  散帧序列：assets\\<组名>\\*.png   （按文件名排序当作帧序，例如 idle-01.png, idle-02.png）\r\n' +
    '  精灵图：  assets\\<组名>.png + assets\\<组名>.json\r\n' +
    '             json 内容示例：{"cols":4,"rows":2,"frameWidth":128,"frameHeight":128}\r\n' +
    '放好后运行：node scripts\\inspect-assets.js --write\r\n');
  console.log('assets\\ 目录已创建，并放了一份说明 README.txt。');
  console.log('主人把 PNG 丢进去之后再跑一次人家就行。');
  process.exit(0);
}

const loaded = loadGroups();
// 过滤器：既支持精确组名，也支持路径片段（例如只体检 assets\resources 下的东西）
const groups = loaded.groups.filter((g) => !only || g.name === only || g.name.includes(only));
if (loaded.loose.length) {
  console.log(`提示：assets\\ 下有 ${loaded.loose.length} 个孤立 PNG（没有同名 .json 描述，按单图忽略）：${loaded.loose.join(', ')}`);
  console.log('      若它们是精灵图，请补一份 <同名>.json：{"cols":4,"rows":2,"frameWidth":128,"frameHeight":128}');
  console.log('      若是一个序列，请放进子目录：assets\\<组名>\\*.png\n');
}
if (!groups.length) {
  console.log('assets\\ 下没有找到素材组。');
  console.log('散帧序列放成：assets\\<组名>\\*.png');
  console.log('精灵图放成：  assets\\<组名>.png + assets\\<组名>.json');
  process.exit(0);
}

let anyProblem = false;
const KIND_LABEL = { sequence: '散帧序列', spritesheet: '精灵图', single: '单张图' };

// 预扫：为了"跨动作组统一角色大小"，先量出每组主体的高度范围，算出全局目标高度。
// 不做这一步的话，idle（主体高 1401）与 hover（主体高 1099）会各自按组内最高帧缩放，
// 结果鼠标一靠近，人物突然变大/变小。
let globalTargetHeight = 0;
if (normalizeHeight) {
  const heights = [];
  for (const g of groups) {
    try {
      const r = inspectGroup(g, { write: false, normalizeHeight: false });
      for (const f of r.frames) if (f.bbox) heights.push(f.bbox.h);
    } catch { /* 解析失败的组跳过 */ }
  }
  if (heights.length) {
    globalTargetHeight = Math.round(Math.max(...heights) * 0.85);
    console.log(`跨组统一：主体高度 ${Math.min(...heights)}~${Math.max(...heights)}px → 统一到 ${globalTargetHeight}px`
      + `（取最高帧的 85%，给取景差异留余地）\n`);
  }
}

for (const g of groups) {
  console.log(`\n===== 素材「${g.name}」（${KIND_LABEL[g.kind] || g.kind}）=====`);
  let r;
  try { r = inspectGroup(g, { write, normalizeHeight, targetHeight: globalTargetHeight }); }
  catch (err) { console.log(`FAIL  无法解析: ${err.message}\n${err.stack}`); anyProblem = true; continue; }

  console.log(`帧数: ${r.frames.length}`);
  if (r.sheet) console.log(`精灵图: ${r.sheet.width}x${r.sheet.height}  ${r.sheet.cols}列 x ${r.sheet.rows}行  单帧 ${r.sheet.frameWidth}x${r.sheet.frameHeight}`);
  if (r.contentSize) console.log(`主体尺寸范围: 宽 ${r.contentSize.wMin}~${r.contentSize.wMax}  高 ${r.contentSize.hMin}~${r.contentSize.hMax}`);
  console.log(`统一画布: ${r.canvas.width}x${r.canvas.height}`);
  console.log('逐帧:');
  for (const f of r.frames.slice(0, 12)) {
    console.log(`  #${String(f.index).padStart(2)} ${String(f.file).padEnd(18)} ${f.width}x${f.height}  主体占比 ${(f.coverage * 100).toFixed(1)}%`
      + `  不透明满像素 ${(f.fullOpaqueRatio * 100).toFixed(1)}%  bbox=${f.bbox ? `${f.bbox.w}x${f.bbox.h}@(${f.bbox.minX},${f.bbox.minY})` : '无'}`);
  }
  if (r.frames.length > 12) console.log(`  ...（共 ${r.frames.length} 帧）`);

  for (const w of r.warnings) console.log(`WARN  ${w}`);
  for (const p of r.problems) console.log(`FAIL  ${p}`);
  if (r.problems.length) anyProblem = true;
  if (r.wrote) console.log(`已输出: ${r.wrote.manifest} + ${r.wrote.count} 张对齐帧 → ${r.wrote.framesDir}`);
}

console.log(`\n===== 结论: ${anyProblem ? '❌ 有问题，先看上面的 FAIL' : '✅ 素材可用'} =====`);
if (!write && !anyProblem) console.log('（加 --write 可以生成对齐帧与 manifest.json）');
process.exit(anyProblem ? 2 : 0);
