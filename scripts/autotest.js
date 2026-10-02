// 一键自检：跑一轮 AUTOTEST，把窗口状态 / 页面度量 / 截图 / 断言全部落到 artifacts/
//
// ★ 为什么要加 --user-data-dir（第 24 轮踩坑换来的）：
//   桌宠是单实例的。如果主人这时候正开着桌宠（便携版/安装版都算），自检进程拿不到那把锁
//   → app.quit() 立刻退出 → 退出码 0、8 秒结束、artifacts\selfcheck.json 还是**上一轮的旧文件**。
//   看起来"自检通过了"，其实是根本没跑。用独立的 userData 目录把锁分开，才能随时自检。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');

const ROOT = path.join(__dirname, '..');
// 每次用一个新的隔离目录：省得上一轮的缓存/单实例锁残留影响这一轮
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pet-autotest-'));

const child = spawn(electron, ['.', `--user-data-dir=${PROFILE}`], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_PET_AUTOTEST: '1' },
});

child.on('exit', (code) => {
  console.log(`\n[autotest] 退出码=${code}  (0=全部断言通过, 2=有失败项, 3=超时, 4=异常)`);
  console.log(`[autotest] 自检用的是隔离数据目录（不影响主人正在跑的那只）：${PROFILE}`);
  // 隔离目录里除了 Electron 的缓存没别的东西，跑完就收掉
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 被占用就算了 */ }
  process.exit(code === null ? 1 : code);
});
