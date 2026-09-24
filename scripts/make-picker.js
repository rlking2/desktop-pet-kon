// 生成选图预览页：把所有抠好的图摆成网格，带文件名和尺寸，方便主人挑。
// 用法: node scripts/make-picker.js
// 产物: artifacts/pick.html （用浏览器打开）
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CUT = path.join(ROOT, 'assets', 'cutout');
const OUT = path.join(ROOT, 'artifacts', 'pick.html');

if (!fs.existsSync(CUT)) {
  console.log('还没有抠图结果，先跑 npm run cutout');
  process.exit(0);
}
const files = fs.readdirSync(CUT).filter((f) => /\.png$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// 读 PNG 尺寸（只读文件头，不解码像素）
function size(p) {
  const fd = fs.openSync(p, 'r');
  try {
    const h = Buffer.alloc(24);
    fs.readSync(fd, h, 0, 24, 0);
    return `${h.readUInt32BE(16)}×${h.readUInt32BE(20)}`;
  } finally { fs.closeSync(fd); }
}

const cards = files.map((f) => {
  const abs = path.join(CUT, f);
  const rel = path.relative(path.dirname(OUT), abs).replace(/\\/g, '/');
  const kb = Math.round(fs.statSync(abs).size / 1024);
  return `
    <div class="card">
      <div class="thumb"><img src="${rel}" alt="${f}" /></div>
      <div class="meta">
        <span class="name">${f.replace(/\.png$/i, '')}</span>
        <span class="dim">${size(abs)} · ${kb}KB</span>
      </div>
    </div>`;
}).join('');

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>挑图 · 桌宠素材</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 24px 60px;
    font-family: "Microsoft YaHei UI", "Microsoft YaHei", sans-serif;
    background: #1b2430; color: #e8eef5;
  }
  h1 { font-size: 18px; margin: 0 0 6px; font-weight: 700; }
  .hint { font-size: 13px; color: #93a4b8; line-height: 1.7; margin-bottom: 18px; }
  .hint b { color: #7fd0f5; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 16px;
  }
  .card {
    background: #243040; border: 1px solid #33445a; border-radius: 10px;
    overflow: hidden; display: flex; flex-direction: column;
  }
  /* 棋盘格底：一眼看出透明区域干不干净 */
  .thumb {
    height: 260px; display: flex; align-items: center; justify-content: center;
    background-color: #d8dee6;
    background-image:
      linear-gradient(45deg, #b9c2cd 25%, transparent 25%, transparent 75%, #b9c2cd 75%),
      linear-gradient(45deg, #b9c2cd 25%, transparent 25%, transparent 75%, #b9c2cd 75%);
    background-size: 20px 20px;
    background-position: 0 0, 10px 10px;
  }
  .thumb img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .meta {
    padding: 8px 10px; display: flex; justify-content: space-between; align-items: baseline;
    border-top: 1px solid #33445a; font-size: 12px;
  }
  .name { font-size: 15px; font-weight: 700; color: #7fd0f5; letter-spacing: .5px; }
  .dim { color: #8fa2b6; font-size: 11px; }
  .legend { margin-top: 26px; font-size: 13px; color: #a8b8c8; line-height: 1.9; }
  .legend code { background: #2c3a4c; padding: 2px 6px; border-radius: 4px; color: #ffd479; }
</style>
</head>
<body>
  <h1>挑图 · 桌宠素材（${files.length} 张）</h1>
  <div class="hint">
    棋盘格底 = 透明区域。<b>边缘干净、没有白边/黑边、主体完整</b>的才好用。<br />
    把主人要的编号告诉人家就行，例如：<b>待机用 1、4、6；交互用 8、J；靠近用 K、Q</b>。<br />
    如果某张边缘有残留（灰边、毛刺），也告诉人家编号，人家调容差重抠。
  </div>
  <div class="grid">${cards}
  </div>
  <div class="legend">
    <b>动作分组怎么用</b>（三条动画互不干扰）：<br />
    待机：角色一直循环播 &nbsp;·&nbsp; 交互：点击／摸头时播一次 &nbsp;·&nbsp; 靠近：鼠标移上去时播<br />
    放进 <code>assets\idle\</code>、<code>assets\interact\</code>、<code>assets\hover\</code> 三个目录即可，<br />
    然后跑 <code>npm run assets:write</code> 生成清单。
  </div>
</body>
</html>`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html, 'utf8');
console.log(`挑图页已生成: ${path.relative(ROOT, OUT)}`);
console.log(`共 ${files.length} 张: ${files.map((f) => f.replace(/\.png$/i, '')).join(', ')}`);
console.log('用浏览器打开即可（图片走相对路径，会直接读 assets/cutout/）');
