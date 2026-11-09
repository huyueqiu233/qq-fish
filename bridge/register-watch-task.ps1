$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$ps1 = Join-Path $here 'watch-dsh-port.ps1'
$vbs = Join-Path $here 'run-watch-hidden.vbs'
$taskName = 'DshQqBridgeWatch'

$action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') `
    -Argument ('"' + $vbs + '"') `
    -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -StartWhenAvailable

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$state = (Get-ScheduledTask -TaskName $taskName).State
Write-Host ('registered ' + $taskName + ' state=' + $state)
