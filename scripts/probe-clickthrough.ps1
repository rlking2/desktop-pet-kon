# 一键完成"OS 层穿透"验证：
#   1. 用探针模式启动桌宠（它会自己在 穿透 ↔ 可交互 之间来回翻转）
#   2. 用 Win32 读取窗口的 WS_EX_TRANSPARENT 位，采样多次
#   3. 断言：必须在两种状态之间真的切换过 —— 这是 setIgnoreMouseEvents 生效的硬证据
#   4. 结束后自动关掉探针桌宠，不打扰主人

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:TEMP 'whale-pet-probe.log'

Write-Host "=== OS 层穿透验证（端到端） ===" -ForegroundColor Cyan

$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
  Write-Host "FAIL  找不到 electron.exe，先跑 npm install" -ForegroundColor Red
  exit 2
}

$env:DSH_PET_PROBE = '1'
$env:DSH_PET_AUTOTEST = ''
$proc = Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"
Write-Host "探针桌宠已启动 (PID $($proc.Id))，等待窗口就绪..."
Start-Sleep -Seconds 4

try {
  & (Join-Path $PSScriptRoot 'verify-windows-clickthrough.ps1')
  $probeExit = $LASTEXITCODE
} finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
  Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $proc.StartTime } | Stop-Process -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "--- 桌宠端日志（探针翻转记录）---"
if (Test-Path $log) {
  Get-Content $log | Where-Object { $_ -match '穿透探针|穿透掩码' } | Select-Object -First 12
}

exit $probeExit
