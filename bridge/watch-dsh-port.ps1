# watch-dsh-port.ps1 -- keep the QQ bridge bound to the CURRENT DSH port.
#
# Why: every DSH restart picks a new random localhost port. The bridge keeps the old
# baseUrl in memory and silently fails to deliver, which looks like "she stopped replying".
# This watcher runs every minute (Scheduled Task DshQqBridgeWatch) and restarts the
# bridge whenever (a) config.json points at a different port than the live DSH, or
# (b) nothing is listening on the bridge console port 3100.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads UTF-8 (no BOM) as ANSI.
$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $here 'config.json'
$logPath = Join-Path $here 'watch.log'
$stampPath = Join-Path $here 'watch-last-restart.txt'

function Write-Log([string]$m) {
    ('[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m) | Out-File -FilePath $logPath -Append -Encoding utf8
    # keep the log small
    $info = Get-Item $logPath
    if ($info.Length -gt 200000) {
        $lines = Get-Content $logPath -Tail 500
        $lines | Out-File -FilePath $logPath -Encoding utf8
    }
}

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
if (-not $port) {
    # DSH is not running right now; nothing to bind to. Stay quiet.
    exit 0
}

$cfgPort = $null
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($cfg.dsh.baseUrl -match ':(\d+)\s*$') { $cfgPort = [int]$Matches[1] }
    } catch {
        Write-Log ('config.json unreadable: ' + $_.Exception.Message)
    }
}

$bridgeUp = $false
$listen = @(Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue)
if ($listen.Count -gt 0) { $bridgeUp = $true }

$needRestart = $false
$why = ''
if ($cfgPort -ne $port) { $needRestart = $true; $why = ('port changed: config=' + $cfgPort + ' live=' + $port) }
elseif (-not $bridgeUp) { $needRestart = $true; $why = 'bridge not listening on 3100' }

# 顺带看住本地克隆音色服务（9880）：挂了会退回机械音，所以直接拉起来
try {
    $cosyScript = if ($env:COSY_START) { $env:COSY_START } else { '' }
    $cosyFlag = Join-Path $PSScriptRoot 'state\no-cosy.flag'
    if ((Test-Path $cosyScript) -and -not (Test-Path $cosyFlag)) {
        $cosyUp = $false
        try { $cosyUp = (Test-NetConnection -ComputerName 127.0.0.1 -Port 9880 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
        if (-not $cosyUp) {
            Write-Log 'cosy voice server not listening; starting'
            Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$cosyScript -WindowStyle Hidden
        }
    }
} catch {
    Write-Log ('cosy check failed: ' + $_.Exception.Message)
}

# 看住 OneBot 网关（3000）：QQ 登录着但网关没跑时自动拉起（2026-11-04）
try {
    $snowDir = if ($env:SNOWLUMA_DIR) { $env:SNOWLUMA_DIR } else { Join-Path (Split-Path $PSScriptRoot -Parent) 'SnowLuma' }
    if (Test-Path $snowDir) {
        $oneBotUp = $false
        try { $oneBotUp = (Test-NetConnection -ComputerName 127.0.0.1 -Port 3000 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
        if (-not $oneBotUp) {
            $qqRunning = @(Get-Process QQ -ErrorAction SilentlyContinue).Count -gt 0
            if ($qqRunning) {
                Write-Log 'OneBot 3000 not listening while QQ is running; starting SnowLuma'
                Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'index.mjs' -WorkingDirectory $snowDir -RedirectStandardOutput (Join-Path $snowDir 'sl.out.log') -RedirectStandardError (Join-Path $snowDir 'sl.err.log') -WindowStyle Hidden
            }
        }
    }
} catch {
    Write-Log ('onebot check failed: ' + $_.Exception.Message)
}

# DSH 本体没在跑 → 拉起来（2026-11-05：它今天自己关过一次）
try {
    $dshProc = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue)
    if ($dshProc.Count -eq 0) {
        Write-Log 'DSH not running; relaunching'
        Start-Process -FilePath 'D:\deep seek\DeepSeek Harness.exe' -WorkingDirectory (Split-Path 'D:\deep seek\DeepSeek Harness.exe' -Parent)
    }
} catch {
    Write-Log ('dsh check failed: ' + $_.Exception.Message)
}

# QQ 客户端没在跑（注入依赖它）→ 只记日志，不自动启动（需要扫码登录）
try {
    if (@(Get-Process QQ -ErrorAction SilentlyContinue).Count -eq 0) {
        Write-Log 'WARN: QQ client is not running -> OneBot injection will be down'
    }
} catch {}

# IndexTTS 语音服务（9881）：挂了就拉起（2026-11-06）
try {
    $itScript = if ($env:INDEXTTS_START) { $env:INDEXTTS_START } else { '' }
    if (Test-Path $itScript) {
        $itUp = $false
        try { $itUp = (Test-NetConnection -ComputerName 127.0.0.1 -Port 9881 -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
        if (-not $itUp) {
            Write-Log 'IndexTTS 9881 not listening; starting'
            Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$itScript -WindowStyle Hidden
        }
    }
} catch {
    Write-Log ('indextts check failed: ' + $_.Exception.Message)
}

if (-not $needRestart) { exit 0 }

# throttle: never restart more than once per 90 seconds
$last = 0
if (Test-Path $stampPath) {
    $raw = (Get-Content $stampPath -Raw).Trim()
    $tmp = 0
    if ([int]::TryParse($raw, [ref]$tmp)) { $last = $tmp }
}
$now = [int][double]::Parse((Get-Date -UFormat %s))
if ($last -gt 0 -and ($now - $last) -lt 90) { exit 0 }
$now | Out-File -FilePath $stampPath -Encoding ascii

Write-Log ('restarting bridge (' + $why + ')')
try {
    & (Join-Path $here 'start-qq-bridge.ps1') *>> (Join-Path $here 'watch-restart.log')
    Write-Log ('bridge restart returned ' + $LASTEXITCODE)
} catch {
    Write-Log ('restart failed: ' + $_.Exception.Message)
}
