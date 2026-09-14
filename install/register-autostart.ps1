# Registers the "C2C Bridge" logon task that starts the bounded supervisor.
# Run this once from ANY PowerShell (elevated or not, matching the install user);
# the supervisor then owns boot ordering: bridge -> tunnel -> provider lanes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-autostart.ps1
#
# Requires the c2c installation this script ships inside (dist/cli/index.js).
$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $installRoot 'dist\cli\index.js'
if (-not (Test-Path $cli)) { throw "c2c CLI not found at $cli; run the installer first." }

$stateDir = Join-Path $env:LOCALAPPDATA 'codex-with-chatgpt'
$workspace = $installRoot

$action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$cli`" supervisor run --workspace `"$workspace`" --state-dir `"$stateDir`"" -WorkingDirectory $installRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName 'C2C Bridge' -Action $action -Trigger $trigger -Force | Out-Null
Write-Host "Registered scheduled task 'C2C Bridge' (logon -> supervisor run)."
