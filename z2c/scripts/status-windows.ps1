# Z2C Windows status: service, task registration, and doctor diagnostics.

$ErrorActionPreference = "Continue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$cli = Join-Path $repoRoot "bin\z2c.js"
$node = (Get-Command node.exe).Source

$task = Get-ScheduledTask -TaskName "Z2C Service" -ErrorAction SilentlyContinue
if ($task) {
    Write-Host "Scheduled task 'Z2C Service': registered (state $($task.State))."
} else {
    Write-Host "Scheduled task 'Z2C Service': NOT registered."
}

& $node $cli status
& $node $cli doctor
