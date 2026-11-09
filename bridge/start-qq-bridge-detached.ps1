# Runs the real starter and logs everything.
# ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 (no BOM) scripts as ANSI.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $here) { $here = $PSScriptRoot }
$log = Join-Path $here 'restart-detached.log'

function Write-Log([string]$m) {
    ('[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m) | Out-File -FilePath $log -Append -Encoding utf8
}

Write-Log 'detached restart begin'
$starter = Join-Path $here 'start-qq-bridge.ps1'
Write-Log ('starter: ' + $starter)
try {
    & $starter *>> $log
    Write-Log ('start-qq-bridge.ps1 returned ' + $LASTEXITCODE)
} catch {
    Write-Log ('ERROR ' + $_.Exception.Message)
}
Write-Log 'detached restart end'
