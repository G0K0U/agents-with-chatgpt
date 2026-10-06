<#
Single-entry, fail-closed local source and candidate gate for A2C + Z2C.
No state-domain or public tunnel mutation occurs in the default mode.
-Activate requires a proven live owner and performs three bounded bridge
handoffs, authenticated public MCP checks, and read-only stability samples.
#>
[CmdletBinding()]
param(
  [string]$A2cRoot = '',
  [string]$Z2cRoot = '',
  [string]$NodePath = 'node.exe',
  [string]$WorkspaceRoot = '',
  [string]$StateDir = '',
  [string]$PausedWorkspaceId = '',
  [string]$PublicHost = '',
  [int]$OriginPort = 0,
  [string]$ExternalTunnelService = '',
  [string]$Z2cStateDir = '',
  [switch]$Activate
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$manifest = $null
$runRoot = $null
if (-not $A2cRoot) { $A2cRoot = Split-Path -Parent $PSScriptRoot }
if (-not $Z2cRoot) { $Z2cRoot = Join-Path $A2cRoot 'z2c' }
if (-not $WorkspaceRoot) { $WorkspaceRoot = $A2cRoot }
if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA 'codex-with-chatgpt' }
if (-not $Z2cStateDir) { $Z2cStateDir = Join-Path $env:LOCALAPPDATA 'z2c' }

function Resolve-Directory([string]$Value, [string]$Label) {
  if (-not [IO.Path]::IsPathRooted($Value) -or -not (Test-Path -LiteralPath $Value -PathType Container)) {
    throw "$Label must be an existing absolute directory"
  }
  return (Resolve-Path -LiteralPath $Value).Path
}

function Source-Fingerprint([string]$Repo, [string[]]$Groups) {
  $rows = [System.Collections.Generic.List[string]]::new()
  foreach ($group in $Groups) {
    $target = Join-Path $Repo $group
    if (-not (Test-Path -LiteralPath $target)) { continue }
    $files = if (Test-Path -LiteralPath $target -PathType Leaf) { @(Get-Item -LiteralPath $target) }
             else { @(Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object { $_.Name -notmatch '\.(bak|log|tsbuildinfo)$' }) }
    foreach ($file in $files) {
      $relative = $file.FullName.Substring($Repo.Length + 1).Replace('\', '/')
      $rows.Add("$relative $((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())")
    }
  }
  $bytes = [Text.Encoding]::UTF8.GetBytes((($rows | Sort-Object) -join "`n"))
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

try {
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'PowerShell 7 or newer is required for reliable native stdout/stderr capture' }
  $A2cRoot = Resolve-Directory $A2cRoot 'A2cRoot'
  $Z2cRoot = Resolve-Directory $Z2cRoot 'Z2cRoot'
  $WorkspaceRoot = Resolve-Directory $WorkspaceRoot 'WorkspaceRoot'
  if (-not [IO.Path]::IsPathRooted($StateDir)) { throw 'StateDir must be absolute' }
  if ($Activate) {
    if (-not $env:A2C_ACCEPTANCE_BEARER) {
      throw 'Activation requires an existing authorized MCP bearer in A2C_ACCEPTANCE_BEARER; pairing is user-operated'
    }
    if ($PausedWorkspaceId -notmatch '^[a-f0-9]{12}$' -or
        $PublicHost -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' -or
        $OriginPort -lt 1 -or $OriginPort -gt 65535 -or
        $ExternalTunnelService -notmatch '^[A-Za-z0-9_.-]+$') {
      throw 'Activation requires a valid paused workspace ID, public host, origin port, and external tunnel service name'
    }
    $Z2cStateDir = Resolve-Directory $Z2cStateDir 'Z2cStateDir'
  }
  $node = (Get-Command $NodePath -ErrorAction Stop).Source
  $npm = Join-Path (Split-Path -Parent $node) 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { throw 'npm.cmd beside Node is required' }
  $pnpm = (Get-Command 'pnpm.cmd' -ErrorAction Stop).Source
  foreach ($required in @(
    (Join-Path $A2cRoot 'package.json'), (Join-Path $A2cRoot 'src/cli/index.ts'),
    (Join-Path $Z2cRoot 'package.json'), (Join-Path $Z2cRoot 'src/service/server.ts')
  )) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing required source: $required" } }
  $env:PATH = "$(Split-Path -Parent $node);$env:PATH"
  $runId = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $runRoot = Join-Path $A2cRoot "artifacts/a2c-release-readiness/$runId"
  New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
  $manifest = [ordered]@{
    schema = 1; runId = $runId; startedAt = (Get-Date).ToUniversalTime().ToString('o')
    a2cRoot = $A2cRoot; z2cRoot = $Z2cRoot; node = $node
    mode = if ($Activate) { 'activate' } else { 'candidate' }
    source = [ordered]@{}; lkgBefore = $null; candidate = $null; activation = $null
    steps = [System.Collections.Generic.List[object]]::new(); result = 'RUNNING'; failure = $null
  }
  $aGroups = @('src','tests','scripts','bin','docs','install','skill','.github','README.md','README.zh-CN.md','AGENTS.md','CHANGELOG.md','LICENSE','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','.gitignore')
  $zGroups = @('src','test','docs','bin','README.md','LICENSE','package.json','package-lock.json','tsconfig.json','.gitignore')
  $manifest.source.a2cBefore = Source-Fingerprint $A2cRoot $aGroups
  $manifest.source.z2cBefore = Source-Fingerprint $Z2cRoot $zGroups
  $pointerFile = Join-Path $A2cRoot 'releases/LKG.json'
  if (Test-Path -LiteralPath $pointerFile -PathType Leaf) {
    $manifest.lkgBefore = Get-Content -LiteralPath $pointerFile -Raw | ConvertFrom-Json
  }

  function Invoke-GateStep([string]$Name, [string]$Repo, [string]$Exe, [string[]]$Arguments) {
    $out = Join-Path $runRoot "$Name.stdout.log"
    $err = Join-Path $runRoot "$Name.stderr.log"
    $start = (Get-Date).ToUniversalTime()
    Push-Location -LiteralPath $Repo
    try {
      & $Exe @Arguments 1> $out 2> $err
      $code = $LASTEXITCODE
    } finally { Pop-Location }
    $manifest.steps.Add([ordered]@{
      name = $Name; startedAt = $start.ToString('o'); endedAt = (Get-Date).ToUniversalTime().ToString('o')
      executable = $Exe; arguments = $Arguments
      exitCode = $code; stdout = [IO.Path]::GetFileName($out); stderr = [IO.Path]::GetFileName($err)
    })
    if ($null -eq $code -or $code -ne 0) { throw "$Name failed with exit code $code; see the saved stdout/stderr" }
    return (Get-Content -LiteralPath $out -Raw)
  }

  function Assert-OkJson([string]$Text, [string]$Step) {
    try { $value = $Text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw "$Step returned invalid JSON" }
    if ($value.ok -ne $true) { throw "$Step returned ok=false" }
    return $value
  }

  Invoke-GateStep 'node-version' $A2cRoot $node @('--version') | Out-Null
  Invoke-GateStep 'a2c-typecheck' $A2cRoot $pnpm @('typecheck') | Out-Null
  Invoke-GateStep 'a2c-focused' $A2cRoot $pnpm @('exec','vitest','run',
    'tests/supervisor-control.test.ts','tests/supervisor.test.ts','tests/tunnel.test.ts',
    'tests/zcode-native.test.ts','tests/zcode-coordinator.test.ts','tests/zcode-session-transport.test.ts',
    'tests/antigravity-c2c.test.ts','tests/restart-handoff.test.ts') | Out-Null
  Invoke-GateStep 'a2c-full' $A2cRoot $pnpm @('exec','vitest','run','--maxWorkers=2') | Out-Null
  Invoke-GateStep 'a2c-build' $A2cRoot $pnpm @('build') | Out-Null
  Invoke-GateStep 'z2c-typecheck' $Z2cRoot $npm @('run','typecheck') | Out-Null
  Invoke-GateStep 'z2c-full' $Z2cRoot $npm @('test') | Out-Null
  Invoke-GateStep 'z2c-build' $Z2cRoot $npm @('run','build') | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $Z2cRoot 'dist/service/main.js') -PathType Leaf)) {
    throw 'Z2C semantic service build entry missing'
  }
  Invoke-GateStep 'a2c-critical-repeat' $A2cRoot $pnpm @('exec','vitest','run',
    'tests/supervisor-control.test.ts','tests/tunnel.test.ts','tests/zcode-native.test.ts',
    'tests/zcode-coordinator.test.ts','tests/zcode-session-transport.test.ts',
    'tests/g4-unified-writer.test.ts','tests/release-lifecycle.test.ts') | Out-Null
  Invoke-GateStep 'z2c-critical-repeat' $Z2cRoot $node @('node_modules/tsx/dist/cli.mjs','--test',
    'test/core.test.ts','test/phase3.test.ts','test/official.test.ts') | Out-Null

  $manifest.source.a2cAfter = Source-Fingerprint $A2cRoot $aGroups
  $manifest.source.z2cAfter = Source-Fingerprint $Z2cRoot $zGroups
  if ($manifest.source.a2cBefore -ne $manifest.source.a2cAfter -or
      $manifest.source.z2cBefore -ne $manifest.source.z2cAfter) {
    throw 'Source changed during the gate; candidate provenance is ambiguous'
  }

  $cli = Join-Path $A2cRoot 'dist/cli/index.js'
  $build = Assert-OkJson (Invoke-GateStep 'candidate-release-build' $A2cRoot $node @($cli,'release','build','--json')) 'candidate-release-build'
  $releaseId = [string]$build.releaseId
  if ($releaseId -notmatch '^[A-Za-z0-9._-]+$') { throw 'Candidate release ID is invalid' }
  $releaseDir = Join-Path $A2cRoot "releases/$releaseId"
  $candidateCli = Join-Path $releaseDir 'cli/index.js'
  $candidateManifest = Join-Path $releaseDir 'build-manifest.json'
  if (-not (Test-Path -LiteralPath $candidateCli -PathType Leaf) -or
      -not (Test-Path -LiteralPath $candidateManifest -PathType Leaf)) { throw 'Candidate release files are incomplete' }
  $candidateBuild = Get-Content -LiteralPath $candidateManifest -Raw | ConvertFrom-Json
  $distBuild = Get-Content -LiteralPath (Join-Path $A2cRoot 'dist/build-manifest.json') -Raw | ConvertFrom-Json
  if ($candidateBuild.sourceRoot -ne 'src' -or $candidateBuild.version -ne $distBuild.version -or
      $candidateBuild.sourceHash -ne $distBuild.sourceHash -or
      $candidateBuild.buildHash -ne $distBuild.buildHash -or
      $releaseId -ne "$($candidateBuild.version)-$($candidateBuild.buildHash.Substring(0, 8))-$($candidateBuild.sourceHash.Substring(0, 8))") {
    throw 'Candidate release manifest does not match the portable source/build identity'
  }
  $manifest.candidate = [ordered]@{
    releaseId = $releaseId; entry = $candidateCli
    entrySha256 = (Get-FileHash -LiteralPath $candidateCli -Algorithm SHA256).Hash.ToLowerInvariant()
    manifestSha256 = (Get-FileHash -LiteralPath $candidateManifest -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $fixtureWorkspace = Join-Path $runRoot 'fixture-workspace'
  $fixtureState = Join-Path $runRoot 'fixture-state'
  New-Item -ItemType Directory -Path $fixtureWorkspace,$fixtureState -Force | Out-Null
  $isolated = Invoke-GateStep 'candidate-isolated-status' $A2cRoot $node @($candidateCli,'status','--workspace',$fixtureWorkspace,'--state-dir',$fixtureState,'--json') | ConvertFrom-Json
  if ($isolated.state -ne 'stopped' -or $isolated.running -ne $false) {
    throw 'Candidate did not report isolated state as stopped'
  }
  $smokeScript = Join-Path $A2cRoot 'scripts/candidate-smoke.mjs'
  $smoke = Assert-OkJson (Invoke-GateStep 'candidate-isolated-smoke' $A2cRoot $node @($smokeScript,$candidateCli,$runRoot,$releaseId)) 'candidate-isolated-smoke'
  if ($smoke.releaseId -ne $releaseId -or $smoke.localHealth -ne 200 -or $smoke.unauthenticatedMcp -ne 401 -or
      $smoke.authenticatedMcp.ok -ne $true -or $smoke.authenticatedMcp.sharedToolsPresent -ne $true) {
    throw 'Candidate isolated bridge smoke did not prove its expected identity and MCP challenge'
  }
  $pointerAfter = if (Test-Path -LiteralPath $pointerFile -PathType Leaf) { Get-Content -LiteralPath $pointerFile -Raw | ConvertFrom-Json } else { $null }
  if (($manifest.lkgBefore | ConvertTo-Json -Compress) -ne ($pointerAfter | ConvertTo-Json -Compress)) {
    throw 'LKG changed during candidate build; refusing deployment'
  }

  if ($Activate) {
    if ($PausedWorkspaceId -notmatch '^[a-f0-9]{12}$' -or
        $PublicHost -notmatch '^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' -or
        $OriginPort -lt 1 -or $OriginPort -gt 65535 -or
        $ExternalTunnelService -notmatch '^[A-Za-z0-9_.-]+$' -or
        -not [IO.Path]::IsPathRooted($Z2cStateDir) -or
        $null -eq $manifest.lkgBefore) {
      throw 'Activation requires a paused workspace ID, public host, origin port, external service name, Z2C state directory, and prior LKG'
    }
    $queueFile = Join-Path $StateDir "queues/$PausedWorkspaceId.json"
    if (-not (Test-Path -LiteralPath $queueFile -PathType Leaf)) { throw 'Maintenance pause state missing' }
    $pause = Get-Content -LiteralPath $queueFile -Raw | ConvertFrom-Json
    if ($pause.workspaceId -ne $PausedWorkspaceId -or $pause.paused -ne $true) { throw 'Selected workspace queue is not maintenance-paused' }
    if (Test-Path -LiteralPath (Join-Path $StateDir "locks/$PausedWorkspaceId.json")) {
      throw 'Selected workspace writer lock is present; refusing activation'
    }
    $live = Invoke-GateStep 'live-owner-proof' $A2cRoot $node @($candidateCli,'status','--workspace',$WorkspaceRoot,'--state-dir',$StateDir,'--json') | ConvertFrom-Json
    if ($live.state -ne 'healthy' -or $live.running -ne $true -or -not $live.pid -or
        $live.port -ne $OriginPort -or $live.publicHost -ne $PublicHost -or
        $live.workspaceId -notmatch '^[a-f0-9]{12}$') {
      throw "Live bridge owner, public host, or origin is not proven (state=$($live.state)); LKG and process unchanged"
    }
    $ownerId = [string]$live.workspaceId
    $z2cState = Get-Content -LiteralPath (Join-Path $Z2cStateDir 'state.json') -Raw | ConvertFrom-Json
    foreach ($id in @($ownerId,$PausedWorkspaceId)) {
      $qProperty = $z2cState.queues.PSObject.Properties[$id]
      if ($null -eq $qProperty) { continue }
      $q = $qProperty.Value
      if ($null -ne $q.activeTask -or @($q.queuedTaskIds).Count -ne 0) { throw "Z2C historical queue $id is not idle" }
    }
    $cloudflared = @(Get-CimInstance Win32_Service -Filter "Name='$ExternalTunnelService'")
    if ($cloudflared.Count -ne 1 -or $cloudflared[0].State -ne 'Running' -or $cloudflared[0].ProcessId -le 0) {
      throw 'Independent Cloudflared service is not running'
    }
    $cloudflaredConfig = Join-Path $StateDir "tunnels/$ownerId/cloudflared.yml"
    if (-not (Test-Path -LiteralPath $cloudflaredConfig -PathType Leaf)) { throw 'External tunnel config missing' }
    $configText = Get-Content -LiteralPath $cloudflaredConfig -Raw
    $origins = [regex]::Matches($configText, 'service\s*:\s*["'']?http://(?:127\.0\.0\.1|localhost):([0-9]+)')
    if ($origins.Count -ne 1 -or $origins[0].Groups[1].Value -ne [string]$OriginPort) {
      throw 'External tunnel origin is not uniquely fixed to the selected loopback port'
    }
    $acceptanceScript = Join-Path $A2cRoot 'scripts/live-acceptance.mjs'
    $acceptanceArgs = @($WorkspaceRoot,$StateDir,$PublicHost,[string]$OriginPort,$ownerId)
    $preflight = Assert-OkJson (Invoke-GateStep 'live-preflight' $A2cRoot $node (@($acceptanceScript,'preflight',$releaseId) + $acceptanceArgs)) 'live-preflight'
    if ($preflight.pid -ne $live.pid -or $preflight.releaseId -ne $manifest.lkgBefore.releaseId) {
      throw 'Live preflight and LKG identity disagree'
    }
    $activated = Assert-OkJson (Invoke-GateStep 'live-activate-pointer' $A2cRoot $node @($candidateCli,'release','activate','--quick','--json')) 'live-activate-pointer'
    if ($activated.pointer.releaseId -ne $releaseId) { throw 'Activation selected an unexpected release' }
    $manifest.activation = [ordered]@{ pointer = $activated.pointer; cycles = [System.Collections.Generic.List[object]]::new(); stability = $null }
    $priorPid = [int]$preflight.pid
    $priorInstance = $null
    for ($cycle = 1; $cycle -le 3; $cycle++) {
      Invoke-GateStep "live-restart-$cycle" $A2cRoot $node @($candidateCli,'restart','--workspace',$WorkspaceRoot,'--state-dir',$StateDir) | Out-Null
      $post = Assert-OkJson (Invoke-GateStep "live-acceptance-$cycle" $A2cRoot $node (@($acceptanceScript,'post',$releaseId) + $acceptanceArgs + @([string]$priorPid))) "live-acceptance-$cycle"
      if ($post.authenticatedMcp.ok -ne $true) { throw "Cycle $cycle did not prove existing authorized MCP" }
      if ($post.pid -eq $priorPid -or ($priorInstance -and $post.instanceId -eq $priorInstance)) {
        throw "Cycle $cycle did not replace the previous bridge instance"
      }
      $manifest.activation.cycles.Add($post)
      $priorPid = [int]$post.pid
      $priorInstance = [string]$post.instanceId
    }
    $stabilityScript = Join-Path $A2cRoot 'scripts/stability-observe.mjs'
    $stabilityArgs = @($stabilityScript,$releaseId,'30',$WorkspaceRoot,$StateDir,$PublicHost,[string]$OriginPort,$ownerId,$PausedWorkspaceId,$Z2cStateDir)
    $stability = Assert-OkJson (Invoke-GateStep 'live-stability-30' $A2cRoot $node $stabilityArgs) 'live-stability-30'
    if ($stability.samples -ne 30 -or $stability.failures -ne 0) { throw 'Read-only stability observation did not pass 30 samples' }
    $manifest.activation.stability = $stability
    $manifest.result = 'LIVE_STABILITY_GATE_PASSED'
    Write-Output "LIVE_STABILITY_GATE_PASSED $releaseId"
  } else {
    $manifest.result = 'CANDIDATE_GATE_PASSED'
    Write-Output "CANDIDATE_GATE_PASSED $releaseId"
  }
} catch {
  if ($null -ne $manifest) {
    $manifest.result = 'FAILED'
    $manifest.failure = $_.Exception.Message
  }
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
} finally {
  if ($null -ne $manifest -and $null -ne $runRoot) {
    $manifest.endedAt = (Get-Date).ToUniversalTime().ToString('o')
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runRoot 'gate.json') -Encoding utf8
  }
}
