// 带红色窗口边框启动桌宠：方便肉眼确认窗口边界与穿透留白范围
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const ROOT = path.join(__dirname, '..');
spawn(electron, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_PET_DEBUG: '1' },
});
