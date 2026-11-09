# start-indextts-server.ps1 — 启动 IndexTTS-2.5 本地服务（端口 9881）
# 注意：它和 CosyVoice 抢显存，两个别同时开。

$root = if ($env:INDEXTTS_ROOT) { $env:INDEXTTS_ROOT } else { $PSScriptRoot }
$py = Join-Path $root 'index-tts\.venv\Scripts\python.exe'
$script = Join-Path $root 'indextts_server.py'
$log = Join-Path $root 'indextts-server.log'

if (-not (Test-Path $py)) { Write-Host "找不到 venv：$py"; exit 1 }

# 已经在跑就不重复启动
$up = $false
try { $up = (Test-NetConnection -ComputerName 127.0.0.1 -Port 9881 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
if ($up) { Write-Host 'IndexTTS 已在 9881 运行'; exit 0 }

Start-Process -FilePath $py -ArgumentList $script, '--port', '9881' -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError (Join-Path $root 'indextts-server.err.log') -WindowStyle Hidden
Start-Sleep -Seconds 3
Write-Host 'IndexTTS 启动中（模型加载约 30~60 秒），日志：' $log
