#Requires -Version 5.1
<#
.SYNOPSIS
  Agents with ChatGPT (C2C) installer for Windows 10/11 x64.

.DESCRIPTION
  One-line install:
    irm https://raw.githubusercontent.com/G0K0U/agents-with-chatgpt/main/install/install.ps1 | iex

  Or with parameters:
    & ([scriptblock]::Create((irm <url>))) -Workspace "C:\my project" -NoTunnel

  The script never disables system security mechanisms and never changes the
  PowerShell execution policy. It installs only user-level tooling and keeps
  user data (state dir, workspaces) intact on uninstall.

.PARAMETER Ref
  Release tag, branch, or commit to install (default main).

.PARAMETER ExpectedCommit
  Optional exact commit SHA that must be checked out; install fails if the
  checked-out commit differs (supply-chain pin).

.EXAMPLE
  .\install.ps1 -Workspace "D:\code\my repo" -Ref main
#>
[CmdletBinding()]
param(
  [string]$RepoUrl = "https://github.com/G0K0U/agents-with-chatgpt.git",
  [string]$Ref = "main",
  [string]$ExpectedCommit = "",
  [string]$InstallRoot = "$env:LOCALAPPDATA\Programs\codex-with-chatgpt",
  [string]$StateDir = "$env:LOCALAPPDATA\codex-with-chatgpt",
  [string]$Workspace = (Get-Location).Path,
  [switch]$NoTunnel,
  [switch]$EnableAutoStart,
  [switch]$Update,
  [switch]$Uninstall,
  [switch]$PurgeUserData,
  [switch]$Doctor,
  [switch]$Json
)

$ErrorActionPreference = 'Stop'
# git writes progress to stderr; keep it from tripping ErrorActionPreference.
$env:GIT_REDIRECT_STDERR = '2>&1'
$script:ExitCode = 0
$script:Steps = New-Object System.Collections.Generic.List[object]
$Cli = Join-Path $InstallRoot 'dist\cli\index.js'

function Step([string]$name, [bool]$ok, [string]$detail = '') {
  $script:Steps.Add([pscustomobject]@{ step = $name; ok = $ok; detail = $detail }) | Out-Null
  if (-not $Json) {
    $mark = if ($ok) { 'OK  ' } else { 'FAIL' }
    Write-Host ("[{0}] {1}{2}" -f $mark, $name, $(if ($detail) { " - $detail" }))
  }
  if (-not $ok) { $script:ExitCode = 1; throw "step failed: $name ($detail)" }
}

function Finish([string]$message) {
  if ($Json) {
    Write-Output ([pscustomobject]@{ ok = ($script:ExitCode -eq 0); message = $message; steps = $script:Steps } | ConvertTo-Json -Depth 5)
  } else {
    Write-Host $message
  }
  exit $script:ExitCode
}

function Test-Cmd([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

try {
  # ── uninstall ──────────────────────────────────────────────────────────────
  if ($Uninstall) {
    $task = Get-ScheduledTask -TaskName 'C2C Bridge' -ErrorAction SilentlyContinue
    if ($task) { Unregister-ScheduledTask -TaskName 'C2C Bridge' -Confirm:$false }
    if (Test-Cmd 'node') { try { node $Cli stop --workspace $Workspace --state-dir $StateDir 2>$null } catch {} }
    if (Test-Path $InstallRoot) { Remove-Item -Recurse -Force $InstallRoot }
    if ($PurgeUserData -and (Test-Path $StateDir)) { Remove-Item -Recurse -Force $StateDir }
    Step 'uninstall' $true ("removed install dir; user data " + $(if ($PurgeUserData) { 'purged' } else { 'kept at ' + $StateDir }))
    Finish 'Uninstall complete.'
  }

  # ── platform checks ────────────────────────────────────────────────────────
  $isWin = [System.Environment]::OSVersion.Platform -eq 'Win32NT'
  Step 'platform: Windows 10/11 x64' $isWin 'this first release targets Windows; other platforms are untested'
  if (-not $isWin) { Finish 'Unsupported platform for this release.' }

  # ── dependency checks / user-level installs ────────────────────────────────
  if (-not (Test-Cmd 'git')) {
    if (Test-Cmd 'winget') {
      Write-Host 'installing Git (winget, user scope)...'
      winget install --id Git.Git --scope user --silent --accept-package-agreements --accept-source-agreements | Out-Null
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
    }
    Step 'git available' (Test-Cmd 'git') 'install Git from https://git-scm.com and re-run'
  } else { Step 'git available' $true }

  if (-not (Test-Cmd 'node')) {
    if (Test-Cmd 'winget') {
      Write-Host 'installing Node.js LTS (winget)...'
      winget install --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements | Out-Null
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path','User') + ';' + $env:Path
    }
    Step 'node available' (Test-Cmd 'node') 'install Node.js >= 20 from https://nodejs.org and re-run'
  }
  $nodeMajor = [int]((node -v) -replace '^v(\d+)\..*','$1')
  Step 'node >= 20' ($nodeMajor -ge 20) ("found node " + (node -v))

  # ── fetch source at the pinned ref ─────────────────────────────────────────
  if (Test-Path (Join-Path $InstallRoot '.git')) {
    git -C $InstallRoot fetch --tags --force origin | Out-Null
    Step 'source fetch' ($LASTEXITCODE -eq 0) "git fetch at $InstallRoot"
    git -C $InstallRoot checkout --force $Ref | Out-Null
    Step "source updated to $Ref" ($LASTEXITCODE -eq 0) $InstallRoot
  } else {
    if (Test-Path $InstallRoot) { Remove-Item -Recurse -Force $InstallRoot }
    New-Item -ItemType Directory -Force -Path (Split-Path $InstallRoot) | Out-Null
    $cloneArgs = @('clone')
    if ($Ref -like 'v*') { $cloneArgs += @('--branch', $Ref, '--depth', '1') }
    $cloneArgs += @($RepoUrl, $InstallRoot)
    git @cloneArgs | Out-Null
    $cloneOk = ($LASTEXITCODE -eq 0)
    if ($cloneOk -and -not ($Ref -like 'v*')) { git -C $InstallRoot checkout $Ref | Out-Null; $cloneOk = ($LASTEXITCODE -eq 0) }
    Step "source cloned at $Ref" ($cloneOk -and (Test-Path (Join-Path $InstallRoot '.git'))) $InstallRoot
  }
  $commit = (git -C $InstallRoot rev-parse HEAD).Trim()
  if ($ExpectedCommit -and $commit -ne $ExpectedCommit) {
    Step 'integrity: pinned commit matches' $false "expected $ExpectedCommit got $commit"
  }
  Step 'integrity: commit recorded' $true $commit

  # ── build ──────────────────────────────────────────────────────────────────
  Push-Location $InstallRoot
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'   # native tools write stderr banners; judge by exit codes
  try {
    corepack enable | Out-Null
    $pnpm = 'pnpm'
    if (-not (Test-Cmd 'pnpm')) { corepack prepare pnpm@latest --activate | Out-Null }
    Step 'pnpm available' (Test-Cmd 'pnpm') 'enable corepack or install pnpm, then re-run'
    & $pnpm install --frozen-lockfile 2>&1 | ForEach-Object { if (-not $Json) { Write-Host "  $_" } }
    $installExit = $LASTEXITCODE
    Step 'dependencies installed' ($installExit -eq 0) "pnpm install exit=$installExit"
    & $pnpm build 2>&1 | ForEach-Object { if (-not $Json) { Write-Host "  $_" } }
    $buildExit = $LASTEXITCODE
    Step 'build completed' ($buildExit -eq 0 -and (Test-Path $Cli)) "pnpm build exit=$buildExit"
    # command shim so the documented `c2c ...` examples work from the install dir
    $shim = Join-Path $InstallRoot 'c2c.cmd'
    Set-Content -Path $shim -Value "@echo off`r`nnode `"%~dp0dist\cli\index.js`" %*"
    Step 'c2c command shim created' (Test-Path $shim) $shim
  } finally { $ErrorActionPreference = $prevEap; Pop-Location }

  # ── doctor ─────────────────────────────────────────────────────────────────
  $ErrorActionPreference = 'Continue'
  if ($Doctor) { node $Cli doctor --workspace $Workspace --state-dir $StateDir; Finish 'Doctor complete.' }
  $doctorOut = node $Cli doctor --workspace $Workspace --state-dir $StateDir 2>&1 | Out-String
  Step 'doctor: preflight' ($LASTEXITCODE -eq 0) $doctorOut.Trim()

  # ── first-time setup (bridge + optional tunnel + pairing) ──────────────────
  $setupArgs = @($Cli, 'setup', '--workspace', $Workspace, '--state-dir', $StateDir)
  if ($NoTunnel) { $setupArgs += '--no-tunnel' }
  if ($Json) { $setupArgs += '--json' }
  Write-Host 'running first-time setup (a browser may open for ChatGPT login)...'
  & node @setupArgs
  $setupExit = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Step 'setup: bridge + pairing ready' ($setupExit -eq 0) "c2c setup exit=$setupExit; complete the browser login, then re-run setup"

  # ── optional autostart (explicit opt-in only) ──────────────────────────────
  # The supervisor is the boot owner: logon -> supervisor -> bridge -> tunnel,
  # then the supervisor reconnects provider lanes (Z2C, desktop agent) itself.
  if ($EnableAutoStart) {
    $action = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$Cli`" supervisor run --workspace `"$Workspace`"" -WorkingDirectory $InstallRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName 'C2C Bridge' -Action $action -Trigger $trigger -Force | Out-Null
    Step 'autostart registered (opt-in)' $true 'Scheduled Task "C2C Bridge" at logon runs the bounded supervisor'
  } else {
    Step 'autostart not requested' $true 'pass -EnableAutoStart to register a logon task'
  }

  Finish @"
Install complete.
  install dir : $InstallRoot (commit $commit)
  state dir   : $StateDir
  workspace   : $Workspace
Next: ChatGPT -> Settings -> Apps & Connectors -> add the MCP URL printed by setup,
      then enter the one-time pairing code.
Update   : re-run this script with -Update
Uninstall: re-run with -Uninstall (user data kept; add -PurgeUserData to remove)
"@
} catch {
  if ($Json) { Finish ("error: " + $_.Exception.Message) }
  else { Write-Host ("ERROR: " + $_.Exception.Message); Write-Host "Fix the cause and re-run; partial installs are detected and repaired on the next run."; exit $script:ExitCode }
}
