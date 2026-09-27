# Z2C Windows installer: registers a per-user login task that starts the
# Z2C local service. No admin rights required (per-user task, per-user state).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1
#
# The task runs at every logon and (re)starts the service if it is not already
# running (the service itself is single-instance via its pid file).

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repoRoot "bin\z2c.js"
if (-not (Test-Path $cli)) { Write-Error "z2c CLI not found at $cli — build first (npm run build)." }

$node = (Get-Command node.exe).Source

# Idempotent start attempt at logon; the CLI is single-instance safe.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$cli`" start" -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "Z2C Service" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Registered scheduled task 'Z2C Service' (starts at logon)."
Write-Host "Starting the service now..."
& $node $cli start
& $node $cli status
Write-Host ""
Write-Host "Next steps:"
Write-Host "  z2c workspace authorize <path>   # authorize a workspace for ZCode sessions"
Write-Host "  z2c pair begin <deviceName>      # pair a ChatGPT connector device"
Write-Host "  z2c doctor                       # diagnostics"
