# 枚举当前所有可见顶层窗口的标题，用来排查 FindWindow 为什么找不到桌宠
$ErrorActionPreference = 'Stop'
Add-Type -Namespace WinEnum -Name Api -MemberDefinition @'
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
'@

$results = New-Object System.Collections.ArrayList
$cb = [WinEnum.Api+EnumWindowsProc]{
  param($h, $l)
  $vis = [WinEnum.Api]::IsWindowVisible($h)
  $sb = New-Object System.Text.StringBuilder 512
  [void][WinEnum.Api]::GetWindowTextW($h, $sb, 512)
  $title = $sb.ToString()
  if ($title -ne '' -or $vis) {
    $cls = New-Object System.Text.StringBuilder 256
    [void][WinEnum.Api]::GetClassNameW($h, $cls, 256)
    $ownerPid = 0
    [void][WinEnum.Api]::GetWindowThreadProcessId($h, [ref]$ownerPid)
    [void]$results.Add([pscustomobject]@{
      Hwnd = ('0x{0:X}' -f [int64]$h)
      Visible = $vis
      Class = $cls.ToString()
      ProcId = $ownerPid
      Title = $title
    })
  }
  return $true
}
[void][WinEnum.Api]::EnumWindows($cb, [IntPtr]::Zero)

"共 $($results.Count) 个窗口，其中可见 $(($results | Where-Object Visible).Count) 个"
"--- 可见且有标题的窗口 ---"
$results | Where-Object { $_.Visible -and $_.Title -ne '' } | Format-Table Hwnd, Class, ProcId, Title -AutoSize
'--- 有没有含「鲸」字的窗口 ---'
$hit = $results | Where-Object { $_.Title -match '鲸' }
if ($hit) { $hit | Format-Table Hwnd, Class, Visible, ProcId, Title -AutoSize } else { "(没有找到含「鲸」的窗口标题)" }
"--- Electron/Chrome 类窗口 ---"
$results | Where-Object { $_.Class -match 'Chrome|Electron' } | Format-Table Hwnd, Class, Visible, ProcId, Title -AutoSize
