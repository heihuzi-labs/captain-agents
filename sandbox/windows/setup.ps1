# Installs everything dispatching needs on Windows in one elevated run (docs/design-windows.md, section 4).
# Called by `xagents windows-setup` after elevation: the owner confirms one UAC prompt.
#   1. The Codex "dedicated account" sandbox for every Codex home in use (each home needs its own setup).
#   2. The loopback fence for the offline sandbox account (loopback-fence.ps1).
# Every step is written to the JSON file given by -Result. The caller creates that file and the Codex homes
# beforehand (a directory created while elevated may not be accessible to the owner).
# Running it again is harmless. -Remove only deletes the fence; Codex's own sandbox has its own uninstall.
#
# Keep this file ASCII only (see loopback-fence.ps1). Messages are codes; the caller turns them into text.
param(
  [Parameter(Mandatory = $true)] [string]$Result,
  [string]$Codex,
  [string]$User,
  # Codex homes joined with '|' (a character no Windows path can contain). One string, because
  # powershell.exe -File does not split array arguments.
  [string]$CodexHomes = '',
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$steps = New-Object System.Collections.ArrayList
$ok = $true
function Step([string]$name, [string]$target, [scriptblock]$body) {
  $entry = @{ name = $name; target = $target; ok = $false; detail = '' }
  try { $entry.detail = [string](& $body); $entry.ok = $true }
  catch { $entry.detail = $_.Exception.Message; $script:ok = $false }
  [void]$steps.Add($entry)
}
try {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'not-elevated' }
  $fence = Join-Path $PSScriptRoot 'loopback-fence.ps1'
  if ($Remove) {
    Step 'fence-remove' '' { (& $fence -Action remove | Out-String).Trim() }
  } else {
    if (-not $Codex -or -not (Test-Path -LiteralPath $Codex -PathType Leaf)) { throw 'codex-missing' }
    if (-not $User) { throw 'user-missing' }
    foreach ($dir in ($CodexHomes -split '\|' | Where-Object { $_ })) {
      Step 'codex-setup' $dir {
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw 'home-missing' }
        $ErrorActionPreference = 'Continue'
        $output = & $Codex sandbox setup --elevated --user $User --codex-home $dir 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) { throw "codex-setup-failed exit=$LASTEXITCODE $($output.Trim())" }
        $output.Trim()
      }
    }
    Step 'fence-install' '' { (& $fence -Action install | Out-String).Trim() }
  }
} catch {
  $ok = $false
  [void]$steps.Add(@{ name = 'setup'; target = ''; ok = $false; detail = $_.Exception.Message })
}
$json = @{ ok = $ok; at = (Get-Date).ToUniversalTime().ToString('o'); steps = $steps } | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($Result, $json, (New-Object Text.UTF8Encoding($false)))
if ($ok) { exit 0 } else { exit 1 }
