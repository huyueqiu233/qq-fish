param([switch]$NoSnowLuma)
$ErrorActionPreference = 'Stop'
$bridgeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $bridgeDir 'config.json'
$snowDir = if ($env:SNOWLUMA_DIR) { $env:SNOWLUMA_DIR } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'SnowLuma' }
$node = 'C:\Program Files\nodejs\node.exe'

function Find-DshPort {
  $ids = @(Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if (-not $ids) { return $null }
  $conns = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -in $ids } |
    Sort-Object LocalPort -Unique
  foreach ($c in $conns) {
    $body = & curl.exe -s --noproxy "*" --max-time 2 "http://127.0.0.1:$($c.LocalPort)/" 2>$null
    if ($body -match 'dsh web authentication required') { return [int]$c.LocalPort }
  }
  return $null
}

$port = Find-DshPort
if (-not $port) { Write-Host 'DSH web port not found. Start DeepSeek Harness first.' -ForegroundColor Red; exit 1 }
Write-Host "DSH port: $port"

if (-not (Test-Path $configPath)) { Copy-Item (Join-Path $bridgeDir 'config.example.json') $configPath }
$cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$cfg.dsh.baseUrl = "http://127.0.0.1:$port"
$cfg.snowluma.launcherPath = Join-Path $snowDir 'launcher.bat'
$cfg.snowluma.homeDir = $snowDir
$json = $cfg | ConvertTo-Json -Depth 30
[IO.File]::WriteAllText($configPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "config.json updated: $configPath"

if (-not $NoSnowLuma) {
  $listening = $false
  try { $listening = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
  if (-not $listening) {
    Write-Host 'Starting SnowLuma ...'
    Start-Process -FilePath $node -ArgumentList 'index.mjs' -WorkingDirectory $snowDir `
      -RedirectStandardOutput (Join-Path $snowDir 'sl.out.log') -RedirectStandardError (Join-Path $snowDir 'sl.err.log') -WindowStyle Hidden
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      try { if ((Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded) { $listening = $true; break } } catch {}
    }
    if ($listening) { Write-Host 'SnowLuma ready (3000)' } else { Write-Host 'SnowLuma not ready; check sl.out.log' -ForegroundColor Yellow }
  } else { Write-Host 'SnowLuma already running (3000)' }
}

Write-Host 'Starting qq-bridge ...'
# ffmpeg/ffprobe 不在系统 PATH 里：语音时长校验会报 ENOENT，补进来（2026-11-03）
$ffmpegDir = Join-Path $env:USERPROFILE '.dsh\tools\ffmpeg\bin'
if (Test-Path $ffmpegDir) { $env:PATH = $ffmpegDir + ';' + $env:PATH }

# Stop a stale bridge first: after a DSH restart the old bridge keeps occupying 3100
# with the OLD baseUrl in memory, and the new one silently fails to bind.
# Symptom: bridge "runs", but QQ gets no replies (2026-10-31 hit this twice).
try {
  $stale = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($sp in $stale) {
    if ($sp -and $sp -ne $PID) {
      Write-Host ('Stopping stale bridge pid ' + $sp)
      Stop-Process -Id $sp -Force -ErrorAction SilentlyContinue
    }
  }
  if ($stale.Count -gt 0) { Start-Sleep -Milliseconds 800 }
} catch { Write-Host 'stale-bridge check skipped' }
Start-Process -FilePath $node -ArgumentList 'src/bridge.js' -WorkingDirectory $bridgeDir `
  -RedirectStandardOutput (Join-Path $bridgeDir 'bridge.out.log') -RedirectStandardError (Join-Path $bridgeDir 'bridge.err.log') -WindowStyle Hidden
Write-Host 'qq-bridge started in background (bridge.out.log / bridge.err.log).'
