# 终极取证：不用合成事件、不用 capturePage。
#   1. 用 Win32 SetCursorPos + mouse_event 移动真实鼠标到桌宠身上并按下/抬起
#      （和主人手动点击走完全同一条系统输入路径）
#   2. 用 .NET Graphics.CopyFromScreen 抓取屏幕真实像素（不是窗口自绘缓冲）
#   3. 分析气泡所在区域有没有真的被画出来
#
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/probe-real-click.ps1

param(
  [int]$SettleMs = 3000,
  [int]$BubbleWaitMs = 600
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace PetInput -Name Api -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }

[StructLayout(LayoutKind.Sequential)]
public struct INPUT {
  public uint type;
  public MOUSEINPUT mi;
}

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
  public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
}

[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);

public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
public const uint MOUSEEVENTF_LEFTUP = 0x0004;
'@

$api = [PetInput.Api]

function Find-PetWindow {
  Add-Type -Namespace PetFind -Name Api -MemberDefinition @'
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@
  $script:found = [IntPtr]::Zero
  $script:rect = $null
  $cb = [PetFind.Api+EnumWindowsProc]{
    param($h, $l)
    $sb = New-Object System.Text.StringBuilder 512
    [void][PetFind.Api]::GetWindowTextW($h, $sb, 512)
    if ($sb.ToString() -eq '鲸鱼娘桌宠') {
      $r = New-Object PetFind.Api+RECT
      [void][PetFind.Api]::GetWindowRect($h, [ref]$r)
      $script:found = $h
      $script:rect = $r
      return $false
    }
    return $true
  }
  [void][PetFind.Api]::EnumWindows($cb, [IntPtr]::Zero)
  return @{ hwnd = $script:found; rect = $script:rect }
}

function Measure-Bubble([System.Drawing.Bitmap]$bmp, [int]$cx, [int]$cy, [int]$w, [int]$h) {
  $light = 0; $total = 0
  $x0 = [Math]::Max(0, $cx); $y0 = [Math]::Max(0, $cy)
  $x1 = [Math]::Min($bmp.Width - 1, $cx + $w); $y1 = [Math]::Min($bmp.Height - 1, $cy + $h)
  for ($y = $y0; $y -lt $y1; $y += 2) {
    for ($x = $x0; $x -lt $x1; $x += 2) {
      $total++
      $p = $bmp.GetPixel($x, $y)
      # 气泡是近白色 (255,255,255) + 天蓝边框 (127,208,245)
      if ($p.R -gt 225 -and $p.G -gt 225 -and $p.B -gt 225) { $light++ }
    }
  }
  return @{ light = $light; total = $total; pct = if ($total) { [Math]::Round($light / $total * 100, 1) } else { 0 } }
}

Write-Host '=== 真实鼠标点击 + 屏幕像素取证 ===' -ForegroundColor Cyan

$info = Find-PetWindow
if ($info.hwnd -eq [IntPtr]::Zero) {
  Write-Host 'FAIL  找不到桌宠窗口（先启动 npm start）' -ForegroundColor Red
  exit 2
}
$r = $info.rect
Write-Host ("窗口: 0x{0:X}  矩形=({1},{2})-({3},{4})  尺寸={5}x{6}" -f [int64]$info.hwnd, $r.Left, $r.Top, $r.Right, $r.Bottom, ($r.Right - $r.Left), ($r.Bottom - $r.Top))

# 窗口逻辑尺寸 200x250，DPI 缩放会让物理尺寸更大；用视口比例换算气泡区域
$physW = $r.Right - $r.Left
$physH = $r.Bottom - $r.Top
$scale = $physW / 200.0
# 气泡在 CSS 里 max-width 186、top 6、高度按内容约 44；位置居中
$bubbleWphys = [int](186 * $scale)
$bubbleHphys = [int](48 * $scale)
$bubbleX = $r.Left + [int](($physW - $bubbleWphys) / 2)
$bubbleY = $r.Top + [int](6 * $scale)
Write-Host ("气泡区域估算: ({0},{1}) {2}x{3}  (缩放系数 {4})" -f $bubbleX, $bubbleY, $bubbleWphys, $bubbleHphys, [Math]::Round($scale, 2))

# 点击点：窗口水平居中、垂直 60% 处（角色身体位置）
$clickX = $r.Left + [int]($physW / 2)
$clickY = $r.Top + [int]($physH * 0.62)
Write-Host ("真实鼠标将移动到 ({0},{1}) 并点击" -f $clickX, $clickY)

Write-Host "等待 $SettleMs ms 让窗口稳定..."
Start-Sleep -Milliseconds $SettleMs

$grabW = [int]$r.Right - [int]$r.Left + 8
$grabH = [int]$r.Bottom - [int]$r.Top + 8
$bubbleRelX = [int]$bubbleX - [int]$r.Left
$bubbleRelY = [int]$bubbleY - [int]$r.Top

function Grab {
  $bmp = New-Object System.Drawing.Bitmap($grabW, $grabH)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$r.Left, [int]$r.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  return $bmp
}

# 1) 点击前
$before = Grab
$b0 = Measure-Bubble -bmp $before -cx $bubbleRelX -cy $bubbleRelY -w $bubbleWphys -h $bubbleHphys
Write-Host ("点击前  气泡区域近白像素: {0}/{1} ({2}%)" -f $b0.light, $b0.total, $b0.pct)

# 2) 真实鼠标点击
[void]$api::SetCursorPos($clickX, $clickY)
Start-Sleep -Milliseconds 150
$api::mouse_event($api::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
$api::mouse_event($api::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Write-Host '已发出真实左键点击（SetCursorPos + mouse_event）'

# 3) 点击后等气泡淡入完成再抓屏
Start-Sleep -Milliseconds $BubbleWaitMs
$after = Grab
$b1 = Measure-Bubble -bmp $after -cx $bubbleRelX -cy $bubbleRelY -w $bubbleWphys -h $bubbleHphys
Write-Host ("点击后  气泡区域近白像素: {0}/{1} ({2}%)" -f $b1.light, $b1.total, $b1.pct)

$outDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$before.Save((Join-Path $outDir 'screen-before-click.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$after.Save((Join-Path $outDir 'screen-after-click.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "屏幕截图已保存: artifacts/screen-before-click.png / screen-after-click.png"

$before.Dispose(); $after.Dispose()

Write-Host ''
if ($b1.pct -gt 8 -and $b1.pct -gt ($b0.pct + 5)) {
  Write-Host 'PASS  真实点击后，屏幕像素里确实出现了气泡（气泡区域近白像素显著增加）' -ForegroundColor Green
  exit 0
} elseif ($b1.pct -le 8) {
  Write-Host 'FAIL  真实点击后，屏幕上看不到气泡' -ForegroundColor Red
  Write-Host '      → 说明气泡没有被绘制，或绘制到了窗口外' -ForegroundColor Yellow
  exit 2
} else {
  Write-Host 'WARN  像素有变化但幅度不足以判定' -ForegroundColor Yellow
  exit 2
}
