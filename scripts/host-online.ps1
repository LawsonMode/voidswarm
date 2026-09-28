# Voidswarm - host online multiplayer from this PC through a Cloudflare Tunnel.
#
# What it does:
#   1. builds the client (npm run build)            - skip with -NoBuild
#   2. opens a Cloudflare quick tunnel to localhost  - a free https://<random>.trycloudflare.com address
#   3. runs the game server bound to 127.0.0.1 only, serving the built client + WebSocket + accounts API,
#      trusting the tunnel's X-Forwarded-For for per-player rate limits
#   4. prints the link to share. Ctrl+C stops both.
#
# One-time setup (you do this yourself):  winget install --id Cloudflare.cloudflared
# Quick tunnels need no Cloudflare account, but the address changes every run. For a permanent address,
# see docs/HOSTING.md ("Named tunnel").
#
# Usage (from the project folder):
#   powershell -ExecutionPolicy Bypass -File scripts\host-online.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\host-online.ps1 -NoBuild -Port 7777
#   powershell -ExecutionPolicy Bypass -File scripts\host-online.ps1 -TunnelUrl https://play.example.com   (named tunnel already running)

param(
  [int]$Port = 7777,
  [switch]$NoBuild,
  [string]$TunnelUrl = '',
  [string]$DbPath = 'data/voidswarm.db'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$cloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue)
if (-not $TunnelUrl -and -not $cloudflared) {
  Write-Host 'cloudflared is not installed. Install it once with:' -ForegroundColor Yellow
  Write-Host '  winget install --id Cloudflare.cloudflared' -ForegroundColor Cyan
  Write-Host 'then open a NEW terminal and run this script again.'
  exit 1
}

if (-not $NoBuild) {
  Write-Host '[1/3] Building the client...' -ForegroundColor Cyan
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
}
if (-not (Test-Path (Join-Path $root 'dist\index.html'))) { throw 'dist\index.html is missing - run without -NoBuild' }

$tunnel = $null
$logFile = Join-Path $env:TEMP ("voidswarm-tunnel-" + [guid]::NewGuid().ToString('N') + '.log')
try {
  if (-not $TunnelUrl) {
    Write-Host '[2/3] Opening a Cloudflare quick tunnel...' -ForegroundColor Cyan
    $tunnel = Start-Process -FilePath $cloudflared.Source `
      -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port") `
      -RedirectStandardError $logFile -RedirectStandardOutput "$logFile.out" -PassThru -NoNewWindow
    # (-NoNewWindow, not a hidden window: antivirus behaviour monitors such as Bitdefender ATD
    #  treat scripts that spawn hidden processes as suspicious.)
    $deadline = (Get-Date).AddSeconds(45)
    while (-not $TunnelUrl -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      if (Test-Path $logFile) {
        $m = Select-String -Path $logFile -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $TunnelUrl = $m.Matches[0].Value }
      }
      if ($tunnel.HasExited) { throw "cloudflared exited early - see $logFile" }
    }
    if (-not $TunnelUrl) { throw "No tunnel address after 45 s - see $logFile" }
  }
  $TunnelUrl = $TunnelUrl.TrimEnd('/')
  $wss = $TunnelUrl -replace '^https://', 'wss://'

  Write-Host ''
  Write-Host '================ VOIDSWARM IS ONLINE ================' -ForegroundColor Magenta
  Write-Host ("  Share this link:   " + $TunnelUrl) -ForegroundColor Green
  Write-Host ("  From the GitHub Pages site, players can use Server... -> " + $wss)
  Write-Host '  Stop hosting with Ctrl+C.'
  Write-Host '=====================================================' -ForegroundColor Magenta
  Write-Host ''

  Write-Host '[3/3] Starting the game server (127.0.0.1 only)...' -ForegroundColor Cyan
  $env:PORT = "$Port"
  $env:BIND = '127.0.0.1'
  $env:TRUST_PROXY = '1'
  $env:PUBLIC_URL = $TunnelUrl
  $env:CORS_ORIGINS = "$TunnelUrl,https://lawsonmode.github.io"
  $env:DB_PATH = $DbPath
  npx tsx src/server/index.ts --serve dist
}
finally {
  if ($tunnel -and -not $tunnel.HasExited) {
    Write-Host 'Closing the tunnel...' -ForegroundColor Cyan
    Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  }
}
