# Voidswarm - host the whole game on this PC for your home or classroom network (LAN).
#
# Easiest way: double-click scripts\host-local.bat. It runs this script and keeps the window open if
# something goes wrong.
#
# What it does:
#   1. checks that Node.js 22.13 or newer is installed (24 LTS recommended: https://nodejs.org)
#   2. installs the game's packages (npm install --no-save) the first time, and again whenever
#      package-lock.json changes (e.g. after an update)
#   3. builds the game (npm run build)                                          - skip with -NoBuild
#   4. starts the server for every device on your network and prints the addresses to open
# Stop it by closing the window or pressing Ctrl+C.
#
# Usage (from a terminal in the game folder):
#   powershell -ExecutionPolicy Bypass -File scripts\host-local.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\host-local.ps1 -Port 7778 -NoBuild
#
# LAN only: plain http, no HTTPS. To host over the internet see scripts\host-online.ps1 and docs/HOSTING.md.
# Guide: docs/LOCAL-HOSTING.md
#
# Keep this file ASCII-only and Windows PowerShell 5.1 compatible (no ?? ?. ternary or && operators).

param(
  [ValidateRange(1, 65535)]
  [int]$Port = 7777,
  [switch]$NoBuild,
  [string]$DbPath = 'data/voidswarm.db',
  [switch]$NoPause   # host-local.bat passes this: it does its own "press any key" on errors
)

$ErrorActionPreference = 'Stop'
$MinNode = [version]'22.13.0'   # node:sqlite (accounts + saves) works without flags from 22.13

function Write-Step([string]$Text) {
  Write-Host ''
  Write-Host $Text -ForegroundColor Cyan
}

function Wait-BeforeClosing {
  if ($NoPause) { return }
  Write-Host ''
  try { $null = Read-Host 'Press Enter to close this window' } catch { }
}

function Stop-WithMessage([string[]]$Lines) {
  Write-Host ''
  foreach ($line in $Lines) { Write-Host $line -ForegroundColor Yellow }
  Wait-BeforeClosing
  exit 1
}

function Find-Tool([string]$Name) {
  $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd }
  # Node may have been installed after this window (or File Explorer) started: re-read PATH from the registry.
  $extra = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User')
  ) | Where-Object { $_ }
  if ($extra) { $env:Path = (@($env:Path) + $extra) -join ';' }
  return (Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Test-PortFree([int]$P) {
  # Read-only: list every listening TCP socket (any address, 127.0.0.1 included) and look for the port. A test
  # bind on 0.0.0.0 would miss a server that listens on 127.0.0.1 only, and could trigger a firewall prompt.
  try {
    $busy = @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
      Where-Object { $_.Port -eq $P })
    return ($busy.Count -eq 0)
  } catch {
    return $true
  }
}

function Get-LanAddresses {
  # Every IPv4 address of a connected adapter, except loopback (127.x) and 169.254.x ("no network" addresses).
  $found = @()
  try {
    foreach ($nic in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      if ($nic.OperationalStatus -ne [System.Net.NetworkInformation.OperationalStatus]::Up) { continue }
      if ($nic.NetworkInterfaceType -eq [System.Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
      foreach ($ua in $nic.GetIPProperties().UnicastAddresses) {
        $addr = $ua.Address
        if ($addr.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { continue }
        if ([System.Net.IPAddress]::IsLoopback($addr)) { continue }
        $text = $addr.ToString()
        if ($text.StartsWith('169.254.')) { continue }
        $found += New-Object PSObject -Property @{ Ip = $text; Adapter = $nic.Name }
      }
    }
  } catch { }
  return $found
}

try { $Host.UI.RawUI.WindowTitle = 'Voidswarm server' } catch { }

# The game folder is the parent of this scripts folder.
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $root 'package.json'))) {
  Stop-WithMessage @(
    "Can't find the game files next to this script.",
    'If you opened the ZIP, right-click it and choose "Extract All" first, then run',
    'scripts\host-local.bat from the extracted folder.'
  )
}
Set-Location -LiteralPath $root

Write-Host '================ VOIDSWARM LOCAL HOST ================' -ForegroundColor Magenta

# --- 1. Node.js ---------------------------------------------------------------
Write-Step '[1/4] Checking Node.js...'
$node = Find-Tool 'node'
if (-not $node) {
  Stop-WithMessage @(
    'Node.js is not installed (or this window cannot see it yet).',
    '  1. Install the LTS version from https://nodejs.org (keep the default options).',
    '  2. Close this window and double-click host-local.bat again.',
    'If it still says this after installing, restart the PC and try again.'
  )
}
$nodeVersion = $null
try {
  $versionText = & $node.Source --version
  if ("$versionText" -match 'v?(\d+)\.(\d+)\.(\d+)') {
    $nodeVersion = [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
  }
} catch { }
if (-not $nodeVersion -or $nodeVersion -lt $MinNode) {
  $shown = 'unknown'
  if ($nodeVersion) { $shown = $nodeVersion.ToString() }
  Stop-WithMessage @(
    ('This PC has Node.js ' + $shown + ', but Voidswarm needs ' + $MinNode.ToString() + ' or newer.'),
    '  1. Install the LTS version (24 or newer) from https://nodejs.org (keep the default options).',
    '  2. Close this window and double-click host-local.bat again.'
  )
}
Write-Host ('  Node.js ' + $nodeVersion.ToString() + ' - OK')

$npm = Find-Tool 'npm'
if (-not $npm) {
  Stop-WithMessage @(
    'npm was not found. It normally comes with Node.js.',
    'Reinstall the LTS version from https://nodejs.org (keep the default options), then try again.'
  )
}

# --- 2. Packages --------------------------------------------------------------
$lockFile = Join-Path $root 'package-lock.json'
$modulesDir = Join-Path $root 'node_modules'
$stampFile = Join-Path $modulesDir '.voidswarm-install-stamp'

function Get-InstallStamp {
  $hash = 'no-lock'
  if (Test-Path -LiteralPath $lockFile) { $hash = (Get-FileHash -LiteralPath $lockFile -Algorithm SHA256).Hash }
  return ($hash + ' node' + $nodeVersion.Major)
}

$needInstall = $true
if ((Test-Path -LiteralPath $modulesDir) -and (Test-Path -LiteralPath $stampFile)) {
  $saved = ''
  try { $saved = [System.IO.File]::ReadAllText($stampFile).Trim() } catch { }
  if ($saved -eq (Get-InstallStamp)) { $needInstall = $false }
}
if ($needInstall) {
  Write-Step '[2/4] Installing the game packages (the first time takes a minute or two)...'
  & $npm.Source install --no-save --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage @(
      'Installing the packages failed (see the messages above).',
      'Check that this PC is online, then run host-local.bat again.',
      'If it keeps failing, delete the node_modules folder in the game folder and try again.'
    )
  }
  # --no-save: install exactly what package-lock.json lists and never rewrite it, so `git pull` stays clean.
  try { [System.IO.File]::WriteAllText($stampFile, (Get-InstallStamp)) } catch { }
} else {
  Write-Step '[2/4] Game packages are up to date.'
}

# --- 3. Build -----------------------------------------------------------------
if ($NoBuild) {
  Write-Step '[3/4] Skipping the build (-NoBuild).'
} else {
  Write-Step '[3/4] Building the game...'
  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) {
    Stop-WithMessage @(
      'The build failed (see the messages above).',
      'If you changed any game files, undo the change or download the game again.'
    )
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $root 'dist\index.html'))) {
  Stop-WithMessage @('The built game (dist\index.html) is missing. Run host-local.bat again without -NoBuild.')
}

# --- 4. Server ----------------------------------------------------------------
Write-Step ('[4/4] Starting the game server on port ' + $Port + '...')
if (-not (Test-PortFree $Port)) {
  Stop-WithMessage @(
    ('Port ' + $Port + ' is already in use on this PC.'),
    'Is Voidswarm already running in another window? Close that window first,',
    ('or start this one on another port, e.g. from a terminal:  scripts\host-local.bat -Port ' + ($Port + 1))
  )
}

$env:PORT = "$Port"
$env:BIND = '0.0.0.0'          # reachable from every device on your network
$env:DB_PATH = $DbPath
# This server is reached directly (no proxy in front), so never trust forwarded addresses here.
Remove-Item Env:TRUST_PROXY -ErrorAction SilentlyContinue
Remove-Item Env:TRUSTED_PROXIES -ErrorAction SilentlyContinue

$lan = @(Get-LanAddresses)
Write-Host ''
Write-Host '================ VOIDSWARM IS STARTING ================' -ForegroundColor Magenta
Write-Host ('  Open http://localhost:' + $Port + ' on this PC.') -ForegroundColor Green
if ($lan.Count -gt 0) {
  foreach ($a in $lan) {
    Write-Host ('  Friends on your network: http://' + $a.Ip + ':' + $Port + '   (' + $a.Adapter + ')') -ForegroundColor Green
  }
} else {
  Write-Host '  No network connection found: only this PC can play right now.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  If Windows Firewall or your antivirus (e.g. Bitdefender) asks about Node.js,'
Write-Host '  allow it on PRIVATE networks only (home / trusted networks).'
Write-Host '  Local network only: plain http, so do not reuse a real password for game accounts.'
Write-Host ('  Saves (accounts, loot, chat log): ' + $DbPath + ' - back up the data folder.')
Write-Host '  Password-reset links print in this window as http://localhost:...; before you pass one on,'
Write-Host '  replace "localhost" with this PC''s address from a "Friends on your network" line above.'
Write-Host '  Stop hosting: close this window or press Ctrl+C.'
Write-Host '=======================================================' -ForegroundColor Magenta
Write-Host ''

# Same as `npx tsx src/server/index.ts --serve dist` (npm start), but run through node directly so Ctrl+C
# goes straight to the server (a clean shutdown) without an extra "Terminate batch job?" question.
$tsxCli = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
$serverExit = 0
try {
  if (Test-Path -LiteralPath $tsxCli) {
    & $node.Source $tsxCli src/server/index.ts --serve dist
  } else {
    & npx tsx src/server/index.ts --serve dist
  }
  $serverExit = $LASTEXITCODE
} finally {
  Write-Host ''
  Write-Host 'Voidswarm has stopped.' -ForegroundColor Cyan
}
if ($serverExit -ne 0 -and $serverExit -ne -1073741510 -and $serverExit -ne 130) {
  # (-1073741510 = 0xC000013A and 130 are how a Ctrl+C stop exits.)
  Stop-WithMessage @(
    ('The server stopped unexpectedly (exit code ' + $serverExit + '). The reason is in the messages above.'),
    ('If it says EADDRINUSE, port ' + $Port + ' is taken: close other copies or use -Port ' + ($Port + 1) + '.')
  )
}
exit 0
