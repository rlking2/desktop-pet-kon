// 一键打包：把「Electron 运行时 + 桌宠代码 + 运行时素材」打成一个**双击就能开**的绿色文件夹。
//
// 为什么不用 electron-builder / electron-packager？
//   它们要联网下载几百 MB 的构建工具链（nsis / winCodeSign / app-builder-bin），
//   在主人的网络环境下又慢又容易失败；而且产物是 NSIS 自解压包，**每次启动都要解压到 %TEMP%**，
//   启动变慢、日志还会写进临时目录（每次都不一样，等于丢了）。
//   而 Electron 自己的发行版**本身就是一个完整可运行的运行时**：
//     - 把 app 放进 resources\app\  （Electron 会优先加载它，而不是内置的 default_app.asar）
//     - 把 electron.exe 改个名
//   就是一个独立程序，而且 Electron 的 exe 是 GUI 子系统 → **双击不会弹控制台窗口**。
//
// 用法:
//   node scripts/make-exe.js                      # → dist\桌宠便携版\桌宠.exe
//   node scripts/make-exe.js --shortcut           # 顺便在桌面放一个快捷方式（默认就放）
//   node scripts/make-exe.js --no-shortcut        # 不放快捷方式
//   node scripts/make-exe.js --out="D:\桌宠"      # 自定义输出目录
//   node scripts/make-exe.js --icon=assets\build\frames\idle\frame-000.png
//
// ⚠️ 打包不会改任何源码；它只是**复制**。改完代码重新跑一次即可。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

// ---------- 命令行参数 ----------
const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq === -1 ? true : hit.slice(eq + 1);
};
const NAME = String(argVal('name', '桌宠'));
const OUT = path.resolve(String(argVal('out', path.join(ROOT, 'dist', '桌宠便携版'))));
const WANT_SHORTCUT = args.includes('--no-shortcut') || argVal('shortcut', true) === 'false' ? false : true;
const ICON_CANDIDATES = [
  String(argVal('icon', '')),
  path.join(ROOT, 'assets', 'build', 'frames', 'happy', 'frame-000.png'),
  path.join(ROOT, 'assets', 'build', 'frames', 'idle', 'frame-000.png'),
].filter(p => p && fs.existsSync(p));
const ICON_SRC = ICON_CANDIDATES[0] || null;
const APP_DIR = path.join(OUT, 'resources', 'app');

// 运行时**真正需要**的东西（其余：13 张挑图、cutout、scripts、docs、devlog、node_modules、.git 都不进包）
const CODE_FILES = ['main.js', 'preload.js', 'lib', 'renderer'];
const ASSET_KEEP = ['manifest.json', 'build'];

function log(msg) { console.log(msg); }
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + ' MB'; }
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

// ---------- 0) 前置检查 ----------
if (!fs.existsSync(path.join(ELECTRON_DIST, 'electron.exe'))) {
  console.error(`❌ 找不到 Electron 运行时: ${ELECTRON_DIST}\\electron.exe`);
  console.error('   先跑一次 npm install（它会下载 Electron）。');
  process.exit(2);
}
const MANIFEST = path.join(ROOT, 'assets', 'manifest.json');
if (!fs.existsSync(MANIFEST)) {
  console.error('❌ 没有 assets\\manifest.json —— 打包出来的桌宠会是"空位提示"，没有形象。');
  console.error('   先按组生成素材清单（注意 --normalize-height 不能省）：');
  console.error('     node scripts\\inspect-assets.js --write --normalize-height idle');
  process.exit(2);
}

// ---------- 1) 处理输出目录（只允许覆盖"上一次打出来的包"） ----------
//
// ⚠️ 踩坑（2026-09-24 实测踩到）：原来这里是"先 rmSync 整个目录，再整份复制"。
//   结果主人**正开着打包版桌宠**去重新打包时：`rmSync` 删到一半，
//   碰到被运行中的进程占用的 `d3dcompiler_47.dll` → EPERM 中断 →
//   **包被删残了**（exe 还在，resources 没了）→ 桌面快捷方式一重启就坏。
//   所以现在改成**同步式**：缺什么补什么、变了才覆盖，**绝不动正在被占用的文件**
//   （它们本来就是同一个 Electron 版本的运行时，内容一模一样，不动才对）。
const versionFile = path.join(OUT, 'version');
const distVersion = fs.readFileSync(path.join(ELECTRON_DIST, 'version'), 'utf8').trim();
if (fs.existsSync(OUT)) {
  const looksLikeOurBuild = fs.existsSync(path.join(OUT, 'resources'))
    || fs.readdirSync(OUT).some((n) => n.endsWith('.exe'));
  if (!looksLikeOurBuild) {
    console.error(`❌ 输出目录已存在，而且不像上次打出来的包，人家不敢动: ${OUT}`);
    console.error('   换一个 --out，或者自己确认后手动删掉。');
    process.exit(2);
  }
  if (args.includes('--clean')) {
    log(`--clean: 先删掉旧产物 ${OUT}`);
    fs.rmSync(OUT, { recursive: true, force: true });
  }
}
fs.mkdirSync(OUT, { recursive: true });

// ---------- 2) 同步 Electron 运行时（缺什么补什么，不删不改被占用的文件） ----------
const syncStats = { copied: 0, same: 0, skippedExe: 0, locked: [] };
// 运行时是不是"已经是最新版本"（决定 electron.exe 要不要重写：它已经被改名成 桌宠.exe 了，
// 没必要每次打包都把 246 MB 复制一遍再删掉；万一 Electron 升级了，这里会变成 false，照常更新）
const prevVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;
const runtimeUpToDate = prevVersion === distVersion;
function syncRuntime(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true });
  for (const e of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, e.name);
    const to = path.join(toDir, e.name);
    if (e.isDirectory()) { syncRuntime(from, to); continue; }
    // default_app.asar 是 Electron 自带的"没写 app 时的占位应用"，
    // 我们有 resources\app\ 了，不需要它（也没必要占 108KB）
    if (e.name === 'default_app.asar' && path.basename(toDir) === 'resources') continue;
    if (e.name === 'electron.exe' && runtimeUpToDate && fs.existsSync(path.join(OUT, `${NAME}.exe`))) {
      syncStats.skippedExe++; continue;   // 已经改名成 桌宠.exe 了，别再复制一份
    }
    let same = false;
    try { same = fs.statSync(from).size === fs.statSync(to).size; } catch { same = false; }
    if (same) { syncStats.same++; continue; }
    try { fs.copyFileSync(from, to); syncStats.copied++; }
    catch (err) { syncStats.locked.push(`${path.relative(OUT, to)}（${err.code}）`); }
  }
}
log(`\n[1/5] 同步 Electron ${distVersion} 运行时…`);
const t0 = Date.now();
syncRuntime(ELECTRON_DIST, OUT);
log(`      新写入 ${syncStats.copied} 个，跳过 ${syncStats.same} 个已一致的`
  + `${syncStats.skippedExe ? '（含已改名的 electron.exe）' : ''}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
if (syncStats.locked.length) {
  log(`      ⚠️ ${syncStats.locked.length} 个文件被占用没更新（正在运行的桌宠占着）——`
    + '它们是同一个 Electron 版本的运行时，内容一致，不影响：');
  for (const f of syncStats.locked.slice(0, 5)) log(`         · ${f}`);
}

// ---------- 3) 复制桌宠本体 ----------
// resources\app 整个重建：这一层不会被执行中的进程锁住（源码/素材都是启动时读进内存的），
// 所以**桌宠开着也能重新打包**，只是它要重启一次才会用上新代码。
log('[2/5] 重建 resources\\app（代码 + 运行时素材）…');
fs.rmSync(APP_DIR, { recursive: true, force: true });
fs.mkdirSync(APP_DIR, { recursive: true });
for (const rel of CODE_FILES) {
  const from = path.join(ROOT, rel);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(APP_DIR, rel), { recursive: true });
}
fs.mkdirSync(path.join(APP_DIR, 'assets'), { recursive: true });
for (const rel of ASSET_KEEP) {
  const from = path.join(ROOT, 'assets', rel);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(APP_DIR, 'assets', rel), { recursive: true });
}

// 打包用的 package.json：去掉 devDependencies / scripts（运行时不需要，也免得被当成"要装依赖"）
//
// ★ 注意 name 必须与仓库里的一致（dsh-desktop-pet）：
//   Electron 用 app.getName() 决定 userData 目录（%APPDATA%\<name>），
//   改了名字 = 待办事项（localStorage）全部丢失 + 单实例锁分开（会同时跑出两只桌宠）。
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main || 'main.js',
  license: pkg.license || 'MIT',
}, null, 2) + '\n');

// ---------- 4) 改 exe 名 + 生成图标 ----------
log('[3/5] 生成 桌宠.exe 与图标…');
const exePath = path.join(OUT, `${NAME}.exe`);
const rawExe = path.join(OUT, 'electron.exe');
// 注意：桌宠正在跑的时候 electron.exe 已经被改成 桌宠.exe 了（而且被占用，动不了），
// 所以这里只在"还没改名"的时候改名，别去碰已经被占用的那个 exe。
if (fs.existsSync(rawExe) && !fs.existsSync(exePath)) {
  fs.renameSync(rawExe, exePath);
} else if (fs.existsSync(rawExe) && fs.existsSync(exePath)) {
  try { fs.rmSync(rawExe, { force: true }); } catch { /* 被占用就算了 */ }
}
if (!fs.existsSync(exePath)) {
  console.error(`❌ 没有生成 ${NAME}.exe —— 运行时同步失败（Electron 装好了吗？）`);
  process.exit(2);
}

const icoPath = path.join(OUT, `${NAME}.ico`);
let iconMade = false;
if (!ICON_SRC) {
  console.error('      ⚠️ 没找到可用作图标的成品帧（先跑素材构建），沿用 Electron 默认图标');
} else {
  try {
    makeIco(ICON_SRC, icoPath);
    iconMade = fs.existsSync(icoPath);
  } catch (err) {
    console.error(`      ⚠️ 图标生成失败（不影响使用）: ${err.message}`);
  }
}

// ---------- 5) 使用说明 ----------
const readme = [
  `${NAME} —— 便携版`,
  '========================================',
  '',
  `【怎么开】双击 ${NAME}.exe（或桌面上的「${NAME}」快捷方式）`,
  '【怎么关】在她身上点右键 → 退出（人家要下班了）',
  '【怎么用】左键点她 → 待办面板；右键 → 菜单（开心（保持动作）/ 摸头 / 回到底部右侧 / 开发者工具 / 退出）',
  '          「开心」是开关：点一次她就保持那个开心的样子（不会自己恢复），**再点一次**才收工。',
  '          菜单里那一项打了勾 = 正在保持中。',
  '【拖动】按住她拖（移动超过 4 像素才开始拖，免得手抖误触）',
  '',
  '【放在哪】整个文件夹可以随便挪（U 盘、别的电脑都行），但**别放进需要管理员权限的目录**',
  '          （比如 C:\\Program Files）：日志要写在 artifacts\\ 里，没权限就写不进去。',
  '          ⚠️ 挪走之后，桌面上那个快捷方式就指丢了 —— 直接在文件夹里双击 ' + `${NAME}.exe` + ' 就行，',
  '             或者在源码仓库里重跑一次 npm run exe，让快捷方式指向新位置。',
  '【日志】artifacts\\input-<时间>.log —— 万一「点了没反应」，把这个日志给人家看。',
  '',
  '【注意】不要同时开两只：第二次启动只会把已经在跑的那只叫到前面来',
  '        （并冒个气泡说"人家在这儿呢"）。单实例锁是**共用同一份配置**的，',
  '        所以以前用 npm start 攒下的待办事项，在 exe 版里照样都在。',
  '',
  '【重新打包】改完源码后，在源码仓库里跑：',
  '    npm run exe        # 重新生成这个文件夹（就是本文件所在的文件夹）',
  '',
].join('\r\n');
fs.writeFileSync(path.join(OUT, '使用说明.txt'), readme, 'utf8');

// ---------- 6) 桌面快捷方式 ----------
let shortcutPath = null;
if (WANT_SHORTCUT) {
  log('[4/5] 在桌面放一个快捷方式…');
  try {
    shortcutPath = makeShortcut(exePath, OUT, icoPath, NAME);
    log(`      已放到桌面: ${shortcutPath}`);
  } catch (err) {
    console.error(`      ⚠️ 快捷方式创建失败（不影响使用，直接双击 exe 也行）: ${err.message}`);
  }
} else {
  log('[4/5] 跳过桌面快捷方式（--no-shortcut）');
}

// ---------- 7) 汇总 ----------
const totalSize = dirSize(OUT);
log('\n[5/5] 打包完成 ✅');
log('────────────────────────────────────────────');
log(`  程序    : ${exePath}`);
log(`  文件夹  : ${OUT}`);
log(`  大小    : ${mb(totalSize)}（Electron 运行时占绝大部分）`);
log(`  图标    : ${iconMade ? icoPath : '（没生成，用 Electron 默认图标）'}`);
log(`  快捷方式: ${shortcutPath || '（无）'}`);
log('────────────────────────────────────────────');
log('双击即可运行，**不会弹控制台窗口**。改完代码重新跑一次本脚本即可。');
if (process.env.DSH_PET_PACKAGED_SELFTEST === '1') {
  log('\n（本次是自检模式，产物路径留给调用方做验证）');
}

// =====================================================================
//  工具函数：图标（PNG → 多尺寸 .ico）与快捷方式
// =====================================================================

// ---------- PNG 解码（8bit，非隔行；RGBA/RGB/灰度/灰度+alpha） ----------
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
  if (!ch) throw new Error('不支持的颜色类型 ' + colorType);
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

// 找"最大的连通块"（= 角色本体，不含旁边飘的彩纸），返回它的包围盒。
// 图标要的是**角色**，不是整张画布：直接用内容包围盒会让角色在图标里显得很小。
function largestComponentBox(rgba, W, H, alphaMin = 40) {
  const label = new Int32Array(W * H).fill(-1);
  const stack = new Int32Array(W * H);
  let best = null;
  for (let start = 0; start < W * H; start++) {
    if (label[start] !== -1 || rgba[start * 4 + 3] < alphaMin) continue;
    const id = start;
    let sp = 0; stack[sp++] = start; label[start] = id;
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
        label[ni] = id;
        if (sp < stack.length) stack[sp++] = ni;
      }
    }
    if (!best || count > best.count) best = { count, minX, minY, maxX, maxY };
  }
  return best;
}

// 从原图里"方形取样框"缩放出一张 size×size 的 RGBA（面积平均 + alpha 加权，避免边缘发黑）
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
          const a = rgba[(sy * W + sx) * 4 + 3];
          sumA += a; sumR += rgba[(sy * W + sx) * 4] * a;
          sumG += rgba[(sy * W + sx) * 4 + 1] * a; sumB += rgba[(sy * W + sx) * 4 + 2] * a;
          n++;
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

// 一个 32bpp DIB（BMP）图标条目：BITMAPINFOHEADER + 自下而上的 BGRA + 全 0 的 AND 掩码
function dibEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);   // 高度 = 2×（XOR 图 + AND 掩码）
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;   // DIB 自下而上
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4, d = (y * size + x) * 4;
      xor[d] = rgba[s + 2]; xor[d + 1] = rgba[s + 1]; xor[d + 2] = rgba[s]; xor[d + 3] = rgba[s + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);   // 全 0 = "不透明由 alpha 决定"
  return Buffer.concat([header, xor, mask]);
}

function makeIco(srcPng, outIco) {
  const img = decodePNG(fs.readFileSync(srcPng));
  const box = largestComponentBox(img.rgba, img.width, img.height) || {
    minX: 0, minY: 0, maxX: img.width - 1, maxY: img.height - 1,
  };
  const bw = box.maxX - box.minX + 1, bh = box.maxY - box.minY + 1;
  const cx = (box.minX + box.maxX + 1) / 2, cy = (box.minY + box.maxY + 1) / 2;
  const side = Math.max(bw, bh) * 1.12;   // 留一点边距，别贴着图标边

  const sizes = [256, 128, 64, 48, 32, 16];
  const images = sizes.map((s) => dibEntry(sampleSquare(img, cx, cy, side, s), s));

  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  sizes.forEach((s, i) => {
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s;   // 256 用 0 表示
    e[1] = s >= 256 ? 0 : s;
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(images[i].length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += images[i].length;
  });
  fs.writeFileSync(outIco, Buffer.concat([dir, ...entries, ...images]));
  console.log(`      图标: ${path.basename(srcPng)} → ${path.basename(outIco)}`
    + `（角色连通块 ${bw}x${bh}，${sizes.join('/')}px 共 ${sizes.length} 档）`);
}

// 桌面快捷方式：用 WScript.Shell（Windows 自带）。
// 写成 .ps1 再执行，而不是 -Command：中文路径在命令行里过一遍编码容易坏。
//
// ⚠️ 踩坑：Node 的 writeFileSync(..., 'utf8') **不会写 BOM**，而 Windows PowerShell 5.1
//    读没有 BOM 的 .ps1 时按 ANSI（中文系统 = GBK）解码 → 中文路径全变乱码，
//    报错 "Unexpected token 'C:\Users\...\妗屽疇\...'"（人家实测踩过）。
//    所以这里必须手动加上 "\uFEFF"。
function makeShortcut(exe, workDir, ico, name) {
  const ps1 = path.join(os.tmpdir(), `dsh-pet-shortcut-${Date.now()}.ps1`);
  const q = (s) => String(s).replace(/'/g, "''");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$desktop = [Environment]::GetFolderPath('Desktop')",
    `$lnk = Join-Path $desktop '${q(name)}.lnk'`,
    '$ws = New-Object -ComObject WScript.Shell',
    '$sc = $ws.CreateShortcut($lnk)',
    `$sc.TargetPath = '${q(exe)}'`,
    `$sc.WorkingDirectory = '${q(workDir)}'`,
    `$sc.IconLocation = '${q(ico)},0'`,
    `$sc.Description = '${q(name)}'`,
    '$sc.Save()',
    'Write-Output $lnk',
  ].join('\r\n') + '\r\n';
  fs.writeFileSync(ps1, '\uFEFF' + script, 'utf8');   // BOM：不然中文路径会被当 GBK 解码
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { encoding: 'utf8' });
    return out.trim().split(/\r?\n/).pop();
  } finally {
    try { fs.unlinkSync(ps1); } catch { /* 临时文件删不掉也无所谓 */ }
  }
}
