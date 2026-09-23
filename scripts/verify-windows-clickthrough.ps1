# 操作系统级穿透验证：直接问 Windows「这个窗口现在能不能被点到」
#
# 原理：Windows 用窗口扩展样式 WS_EX_TRANSPARENT (0x20) 标记「鼠标穿透」。
#      Electron 的 setIgnoreMouseEvents(true) 在 Windows 上就是给它加这个位。
#      用 FindWindow 找窗口在高 DPI / 透明窗口下不稳定，这里改用 EnumWindows 按标题匹配。
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-windows-clickthrough.ps1
param(
  [int]$WaitSeconds = 20,
  [int]$Samples = 16
)

$ErrorActionPreference = 'Stop'

Add-Type -Namespace PetProbe -Name Api -MemberDefinition @'
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
'@

$api = [PetProbe.Api]
$script:found = [IntPtr]::Zero

function Find-PetWindow {
  $script:found = [IntPtr]::Zero
  $cb = [PetProbe.Api+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void]$api::GetWindowTextW($h, $sb, 512)
    if ($sb.ToString() -eq '鲸鱼娘桌宠') {
      $script:found = $h
      return $false
    }
    return $true
  }
  [void]$api::EnumWindows($cb, [IntPtr]::Zero)
  return $script:found
}

Write-Host '=== 操作系统级穿透验证 ===' -ForegroundColor Cyan
Write-Host "等待桌宠窗口出现（最多 $WaitSeconds 秒）..."

$deadline = (Get-Date).AddSeconds($WaitSeconds)
$hwnd = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $hwnd = Find-PetWindow
  if ($hwnd -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 300
}

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Host 'FAIL  找不到标题为「鲸鱼娘桌宠」的窗口（桌宠没启动？）' -ForegroundColor Red
  exit 2
}

$cls = New-Object System.Text.StringBuilder 256
[void]$api::GetClassNameW($hwnd, $cls, 256)
Write-Host ("找到窗口: 句柄 0x{0:X}  类名 {1}  可见 {2}" -f [int64]$hwnd, $cls.ToString(), $api::IsWindowVisible($hwnd))
Write-Host ''

$transparentCount = 0
$opaqueCount = 0
$uniq = New-Object System.Collections.Generic.HashSet[int]

for ($i = 1; $i -le $Samples; $i++) {
  $ex = $api::GetWindowLong($hwnd, -20)   # GWL_EXSTYLE
  $isTransparent = [bool]($ex -band 0x20)
  [void]$uniq.Add($ex)
  if ($isTransparent) { $transparentCount++ } else { $opaqueCount++ }
  Write-Host ("  #{0,-2} EXSTYLE=0x{1:X8}  WS_EX_TRANSPARENT={2}" -f $i, [int64]$ex, $isTransparent)
  Start-Sleep -Milliseconds 250
}

Write-Host ''
Write-Host ("不同的 EXSTYLE 取值: {0}" -f (($uniq | Sort-Object) -join ', '))
Write-Host "穿透态(0x20 置位) $transparentCount 次 / 可交互态 $opaqueCount 次（共 $Samples 次）"
Write-Host ''

if ($transparentCount -gt 0 -and $opaqueCount -gt 0) {
  Write-Host 'PASS  捕获到双向切换 —— setIgnoreMouseEvents 确实作用到了 OS 层' -ForegroundColor Green
  Write-Host '      窗口真的在「穿透 / 可交互」之间跟着状态翻转' -ForegroundColor Green
  exit 0
} elseif ($transparentCount -eq $Samples) {
  Write-Host 'PASS  窗口稳定处于穿透态' -ForegroundColor Green
  Write-Host '      说明 setIgnoreMouseEvents(true) 已作用到 OS 层' -ForegroundColor Green
  exit 0
} elseif ($opaqueCount -eq $Samples) {
  Write-Host 'FAIL  窗口始终不具备 WS_EX_TRANSPARENT —— 穿透没有生效' -ForegroundColor Red
  Write-Host '      （若桌宠正处于拖动中或鼠标停在角色上，也可能读到这种状态）' -ForegroundColor Yellow
  exit 2
} else {
  Write-Host 'FAIL  穿透状态不稳定' -ForegroundColor Red
  exit 2
}
