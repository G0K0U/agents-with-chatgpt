// Finite operator entry: reuse the existing LKG CLI/supervisor, never schedule work.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  json: { type: 'boolean', default: false },
  'state-dir': { type: 'string' },
  'wait-seconds': { type: 'string' },
}});
const action = positionals[0] ?? 'status';
if (positionals.length > 1 || !['status', 'start'].includes(action)) {
  process.stderr.write('Usage: node scripts/engineering-ai-workflow.mjs [status|start] [--json] [--wait-seconds 1..120] [--state-dir <existing state>]\n');
  process.exit(1);
}
const waitSeconds = Number(values['wait-seconds'] ?? (action === 'start' ? 60 : 10));
if (!Number.isInteger(waitSeconds) || waitSeconds < 1 || waitSeconds > 120) {
  process.stderr.write('wait-seconds must be an integer between1 and120\n');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'c2c.js');
const run = promisify(execFile);
const stateArgs = values['state-dir'] ? ['--state-dir', path.resolve(values['state-dir'])] : [];

async function call(args, timeoutMs = 12000) {
  let stdout;
  let exit = 0;
  try {
    ({ stdout } = await run(process.execPath, [cli, ...stateArgs, ...args, '--json'], {
      cwd: root, windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    stdout = error.stdout;
    exit = typeof error.code === 'number' ? error.code : 1;
  }
  try { return { exit, data: JSON.parse(stdout) }; }
  catch { return { exit: exit || 1, data: null }; } // Never print raw stderr/state/credentials.
}

async function observe(timeoutMs) {
  const [health, supervisor, dispatch, effort] = await Promise.all([
    call(['health', '--workspace', root], timeoutMs),
    call(['supervisor', 'status', '--workspace', root], timeoutMs),
    call(['dispatch-policy', 'status', '--workspace', root], timeoutMs),
    call(['worker-effort-policy', 'status'], timeoutMs),
  ]);
  const h = health.data;
  const s = supervisor.data;
  const d = dispatch.data;
  const e = effort.data;
  const controlReady = health.exit === 0 && h?.READY === true &&
    supervisor.exit === 0 && s?.ok === true && s?.running === true && s?.overall === 'READY';
  const highest = effort.exit === 0 && e?.glmAndGemini === 'highest';
  const dispatchKnown = dispatch.exit === 0 && typeof d?.effectivePaused === 'boolean';
  const readyForDotGate = controlReady && highest && dispatchKnown && d.effectivePaused === false;
  const failure = !s?.running ? 'SUPERVISOR_NOT_VERIFIED'
    : !controlReady ? (h?.LAST_ERROR_CODE ?? h?.error_code ?? 'CONTROL_PLANE_NOT_READY')
    : !highest ? 'HIGHEST_EFFORT_POLICY_NOT_VERIFIED'
    : !dispatchKnown ? 'DISPATCH_POLICY_NOT_VERIFIED'
    : d.effectivePaused ? (d.envOverride?.active ? 'ENV_OVERRIDE_ACTIVE' : 'PRODUCT_DISPATCH_PAUSED') : null;
  return {
    schema: 1, observedAt: new Date().toISOString(), action,
    controlPlane: controlReady ? 'READY' : (h?.READY_STATE ?? 'UNKNOWN'),
    recoverySupervisor: { state: s?.overall ?? 'UNKNOWN', running: s?.running === true, pid: s?.pid ?? null },
    providerState: h?.PROVIDER_STATE ?? 'UNKNOWN', generation: h?.GENERATION ?? null,
    reconciling: h?.RECONCILING === true,
    dispatch: dispatchKnown ? (d.effectivePaused ? 'PAUSED' : 'ENABLED') : 'UNKNOWN',
    envPauseOverride: d?.envOverride?.active ?? null,
    workerEffort: highest ? 'HIGHEST' : 'UNVERIFIED',
    readyForDotGate, error_code: failure, failure_layer: h?.LAST_FAILURE_LAYER ?? h?.failure_layer ?? null,
    dotAndWorkspace: 'REQUIRES_LIVE_READBACK_IN_EXISTING_DOT',
    runbook: path.join(root, 'docs', 'engineering-ai-workflow.md'),
  };
}

let result;
if (action === 'start') {
  // The formal CLI revalidates owner/generation and reuses an already running supervisor.
  const started = await call(['supervisor', 'start', '--workspace', root], 25000);
  if (started.exit !== 0 || started.data?.ok !== true) {
    // The formal start command can return a verified PID before the first
    // readiness tick. Re-read owner proof; never infer success from PID alone
    // or issue another start. A proven same process may continue bounded waits.
    const observed = await call(['supervisor', 'status', '--workspace', root], 12000);
    const sameOwner = observed.data?.running === true && observed.data?.processStatus === 'same' &&
      Number.isInteger(started.data?.pid) && observed.data.pid === started.data.pid;
    if (!sameOwner) {
      result = { schema: 1, observedAt: new Date().toISOString(), action,
        controlPlane: 'UNKNOWN', readyForDotGate: false,
        error_code: 'SUPERVISOR_START_NOT_VERIFIED',
        dotAndWorkspace: 'NOT_STARTED', runbook: path.join(root, 'docs', 'engineering-ai-workflow.md') };
    }
  }
}
if (!result) {
  const deadline = Date.now() + waitSeconds * 1000;
  do {
    result = await observe(Math.max(1, Math.min(12000, deadline - Date.now())));
    if (result.readyForDotGate || Date.now() >= deadline) break;
    // Status may wait for reconciliation or a proven live supervisor's first
    // readiness tick. Neither mode clears pauses or restarts that supervisor.
    if (result.error_code === 'ENV_OVERRIDE_ACTIVE' || result.error_code === 'PRODUCT_DISPATCH_PAUSED' ||
      result.error_code === 'HIGHEST_EFFORT_POLICY_NOT_VERIFIED' ||
      result.error_code === 'AUTH_REQUIRED' || result.error_code === 'VERSION_MISMATCH' ||
      (action === 'status' && !result.reconciling && !(result.recoverySupervisor?.running &&
        ['OFFLINE', 'RECOVERING'].includes(result.recoverySupervisor.state)))) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
}
if (values.json) process.stdout.write(JSON.stringify(result) + '\n');
else process.stdout.write([
  `CONTROL PLANE: ${result.controlPlane}`,
  `RECOVERY SUPERVISOR: ${result.recoverySupervisor?.state ?? 'UNKNOWN'}`,
  `PRODUCT DISPATCH: ${result.dispatch ?? 'UNKNOWN'}`,
  `GLM/GEMINI EFFORT: ${result.workerEffort ?? 'UNVERIFIED'}`,
  `CAUSE: ${result.error_code ?? 'NONE'}`,
  `DOT / WORKSPACE: ${result.dotAndWorkspace}`,
  `SAVED WORKFLOW: ${result.runbook}`,
].join('\n') + '\n');
process.exitCode = result.readyForDotGate ? 0 : 2;
