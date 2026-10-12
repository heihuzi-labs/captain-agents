# 一次装齐 Windows 上派活要用的隔离（docs/design-windows.md 第 4 节）。要管理员权限：由 xagents windows-setup 提权后调用，
# 主人只需要在系统弹出的确认框上点一次“是”。
#   1. 给每个要用的 Codex 文件夹装 Codex 自带的“专用账户”隔离（每个文件夹要各装一次，实测）。
#   2. 给离线专用账户补上“本机回环”的拦截（loopback-fence.ps1）。
# 每一步的结果写进 -Result 指定的 JSON 文件；这个文件和各个 Codex 文件夹都由调用方事先建好（提权后建的目录主人可能没有权限）。
# 重复运行没有副作用。-Remove 只撤掉第 2 步的规则；Codex 自己的隔离用它自己的卸载命令撤。
param(
  [Parameter(Mandatory = $true)] [string]$Result,
  [string]$Codex,
  [string]$User,
  [string[]]$CodexHome = @(),
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$steps = New-Object System.Collections.ArrayList
$ok = $true
function Step([string]$name, [scriptblock]$body) {
  $entry = @{ name = $name; ok = $false; detail = '' }
  try { $entry.detail = [string](& $body); $entry.ok = $true }
  catch { $entry.detail = $_.Exception.Message; $script:ok = $false }
  [void]$steps.Add($entry)
}
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw '需要管理员权限。' }
  $fence = Join-Path $PSScriptRoot 'loopback-fence.ps1'
  if ($Remove) {
    Step 'fence-remove' { (& $fence -Action remove | Out-String).Trim() }
  } else {
    if (-not $Codex -or -not (Test-Path -LiteralPath $Codex -PathType Leaf)) { throw "找不到 Codex 程序：$Codex" }
    if (-not $User) { throw '缺少主人的账户名。' }
    foreach ($dir in $CodexHome) {
      Step "codex-setup:$dir" {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw "文件夹不存在：$dir" }
        $output = & $Codex sandbox setup --elevated --user $User --codex-home $dir 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "Codex 安装隔离失败（退出码 $LASTEXITCODE）：$($output.Trim())" }
        $output.Trim()
      }
    }
    Step 'fence-install' { (& $fence -Action install | Out-String).Trim() }
  }
} catch {
  $ok = $false
  [void]$steps.Add(@{ name = 'setup'; ok = $false; detail = $_.Exception.Message })
}
$json = @{ ok = $ok; at = (Get-Date).ToUniversalTime().ToString('o'); steps = $steps } | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($Result, $json, (New-Object Text.UTF8Encoding($false)))
if ($ok) { exit 0 } else { exit 1 }
