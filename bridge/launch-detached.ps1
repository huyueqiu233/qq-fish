# Starts the QQ bridge through Task Scheduler so it is NOT a child of this
# DSH background job: archiving the session / closing the job no longer kills it.
# ASCII-only on purpose (Windows PowerShell 5.1 misreads UTF-8 as ANSI).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $here) { $here = $PSScriptRoot }
$ps1 = Join-Path $here 'start-qq-bridge-detached.ps1'
if (-not (Test-Path $ps1)) { Write-Error ('missing ' + $ps1); exit 1 }

$taskName = 'DshQqBridgeStart'
$pwshExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# -WindowStyle Hidden: Task Scheduler runs powershell via Windows Terminal on Win11 and
# leaves a visible console panel. Hidden keeps the desktop clean.
# NOTE: keep this file ASCII-only - PowerShell 5.1 reads UTF-8 as ANSI and CJK comments break parsing.
$action = New-ScheduledTaskAction -Execute $pwshExe `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ps1 + '"') `
    -WorkingDirectory $here
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $taskName).State
$info = Get-ScheduledTaskInfo -TaskName $taskName
Write-Host ('task ' + $taskName + ' state=' + $state + ' lastResult=' + $info.LastTaskResult)
