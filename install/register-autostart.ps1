# Registers the "C2C Bridge" supervisor logon task.
# Run once from ANY PowerShell (elevated or not, matching the install user);
# the supervisor then owns boot ordering: bridge -> tunnel -> provider lanes.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File register-autostart.ps1
#
# Requires the c2c installation this script ships inside (bin\c2c.js).
$ErrorActionPreference = 'Stop'

$installRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $installRoot 'bin\c2c.js'
if (-not (Test-Path $cli)) { throw "c2c CLI not found at $cli; run the installer first." }

$stateDir = Join-Path $env:LOCALAPPDATA 'codex-with-chatgpt'
$workspace = $installRoot
$user = "$env:COMPUTERNAME\$env:USERNAME"

# Resolve the ABSOLUTE node executable. A bare 'node.exe' depends on the
# logon-time PATH; Task Scheduler launches with a minimal environment, so a
# PATH-relative executable fails with 0x80070002 (FILE_NOT_FOUND) and the
# supervisor silently never starts after a reboot.
$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) {
  foreach ($candidate in @(
    (Join-Path $env:LOCALAPPDATA 'Programs\node\node.exe'),
    'C:\Program Files\nodejs\node.exe'
  )) {
    if (Test-Path $candidate) { $node = $candidate; break }
  }
}
if (-not $node -or -not (Test-Path $node)) { throw 'node.exe could not be located; install Node.js 20+ first.' }

$action = New-ScheduledTaskAction -Execute $node `
  -Argument "`"$cli`" supervisor run --workspace `"$workspace`" --state-dir `"$stateDir`"" `
  -WorkingDirectory $workspace

# The trigger MUST be scoped to the registering user: an unscoped logon
# trigger (any user) is admin-only and registration fails with access denied.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive

# No 72h execution limit (the supervisor is a long-lived control-plane
# process), start as soon as possible after a missed logon slot, and run on
# battery power. Restart-on-failure is best-effort: some non-elevated
# contexts reject it at registration, so it is applied only when accepted.
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
try {
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
} catch { Write-Warning 'RestartOnFailure not accepted by Task Scheduler; registering without it.' }

Register-ScheduledTask -TaskName 'C2C Bridge Supervisor' -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force | Out-Null
# Retain the legacy task for inspection, but leave only one autostart owner.
if (Get-ScheduledTask -TaskName 'C2C Bridge' -ErrorAction SilentlyContinue) {
  Disable-ScheduledTask -TaskName 'C2C Bridge' | Out-Null
}
Write-Host "Registered scheduled task 'C2C Bridge Supervisor' (LKG-aware launcher, node: $node)."
