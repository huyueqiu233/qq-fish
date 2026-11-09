' run-watch-hidden.vbs
' Launches watch-dsh-port.ps1 with NO console window.
' Task Scheduler starting powershell.exe directly flashes a black console window
' once a minute; wscript is a GUI host, so its child PowerShell runs invisible.
Dim shell, scriptDir, cmd
Set shell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "watch-dsh-port.ps1"""
shell.Run cmd, 0, False
