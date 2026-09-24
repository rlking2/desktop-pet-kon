// ⚠️ 这个脚本会画出**红色虚线窗口边框**（DSH_PET_DEBUG=1），只用来自查窗口边界与穿透留白。
// 平时给主人看的时候千万不要用这个启动方式 —— 用 `npm start`。
// 主人曾经因为人家一直用这个脚本启动，以为桌宠天生带边框。
const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');

const ROOT = path.join(__dirname, '..');
console.log('[提示] 调试边框模式：窗口四边会显示红色虚线与角标，仅用于排查边界问题。');
console.log('[提示] 只想正常使用请改用：npm start\n');
spawn(electron, ['.'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DSH_PET_DEBUG: '1' },
});
