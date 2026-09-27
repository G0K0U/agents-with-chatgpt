# Z2C Windows uninstaller: stops the service, unregisters the logon task.
# User state under %LOCALAPPDATA%\z2c is PRESERVED by default; pass -PurgeState
# to also delete it. Never touches ZCode's own state (~/.zcode).

param(
    [switch]$PurgeState
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repoRoot "bin\z2c.js"
$node = (Get-Command node.exe).Source

Write-Host "Stopping Z2C service..."
& $node $cli stop 2>$null

Unregister-ScheduledTask -TaskName "Z2C Service" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Unregistered scheduled task 'Z2C Service'."

if ($PurgeState) {
    $stateDir = Join-Path $env:LOCALAPPDATA "z2c"
    if (Test-Path $stateDir) {
        Remove-Item -Recurse -Force $stateDir
        Write-Host "Deleted Z2C state directory $stateDir."
    }
} else {
    Write-Host "Z2C state preserved at $((Join-Path $env:LOCALAPPDATA 'z2c')) (pass -PurgeState to delete)."
}

Write-Host "Z2C uninstalled. ZCode's own state was not touched."
