// 一键自检：跑一轮 AUTOTEST，把窗口状态 / 页面度量 / 截图 / 断言全部落到 artifacts/
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const ROOT = path.join(__dirname, '..');
const child = spawn(electron, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_PET_AUTOTEST: '1' },
});

child.on('exit', (code) => {
  console.log(`\n[autotest] 退出码=${code}  (0=全部断言通过, 2=有失败项, 3=超时, 4=异常)`);
  process.exit(code === null ? 1 : code);
});
