import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const leaseFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta'), 'd2c-selection-lease.json');
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const selection = (value) => ({ provider: value?.provider ?? null, model: value?.model ?? null,
  reasoningEffort: value?.reasoningEffort ?? null });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flag = (rows, name) => Array.isArray(rows) ? rows.find((row) => row?.flag === name)?.value : null;

function regularModelFile(dir, name) {
  if (!dir || !name || path.basename(name) !== name) return false;
  try { return fs.statSync(path.join(dir, name)).isFile(); } catch { return false; }
}

/** Derive executable capabilities from the controller's effective slot config. */
export function slotCapabilities(local) {
  const config = local?.config;
  if (!config || !Number.isInteger(config.port) || !config.slots) return [];
  return ['a', 'b'].flatMap((slot) => {
    const value = config.slots[slot];
    if (!value || !regularModelFile(value.dir, value.file) || value.alias !== value.file) return [];
    const backend = value.backend === 'ninfer' ? 'ninfer' : value.backend === 'kvmem' ? 'kvmem' : null;
    if (!backend) return [];
    const vision = backend === 'kvmem' && regularModelFile(value.dir, value.mmproj)
      && Array.isArray(value.presets?.['vision:fast']) && Array.isArray(value.presets?.['vision:long']);
    const profile = vision ? 'vision:fast' : 'text:fast';
    const rows = value.presets?.[profile];
    const context = Number(flag(rows, backend === 'ninfer' ? '--max-context' : '-c'));
    if (!Number.isSafeInteger(context) || context < 512) return [];
    return [{ model: value.alias, backend, slot, mode: vision ? 'vision' : 'text', preset: 'fast',
      profile, contextWindow: context, inputModalities: vision ? ['text', 'image'] : ['text'],
      multimodalEvidence: vision ? 'configured mmproj file and vision profiles' : null }];
  });
}

function load(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.schema !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
      fail('D2C_LEASE_STORE_INVALID', 'Selection lease state is invalid');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { schema: 1, sequence: 0, active: null };
    if (error?.code?.startsWith?.('D2C_')) throw error;
    fail('D2C_LEASE_STORE_INVALID', 'Selection lease state cannot be read');
  }
}

function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function waitFor(ctx, eventName, condition, timeoutMs, timeoutCode, signal) {
  return new Promise((resolve, reject) => {
    let dispose;
    const abort = () => { clearTimeout(timer); dispose?.(); reject(Object.assign(new Error('DSH transition cancelled'), { code: 'D2C_SWITCH_CANCELLED' })); };
    const timer = setTimeout(() => {
      dispose?.();
      signal?.removeEventListener('abort', abort);
      reject(Object.assign(new Error('DSH controller transition timed out'), { code: timeoutCode }));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    dispose = ctx.on(eventName, (...args) => {
      try {
        const result = condition(...args);
        if (result === undefined) return;
        clearTimeout(timer); dispose?.(); signal?.removeEventListener('abort', abort); resolve(result);
      } catch (error) {
        clearTimeout(timer); dispose?.(); signal?.removeEventListener('abort', abort); reject(error);
      }
    });
  });
}

/** One active global selection lease inside the authenticated DSH runtime. */
export class DshSelectionLease {
  constructor(ctx, generation, options = {}) {
    this.ctx = ctx;
    this.generation = generation;
    this.file = options.file ?? leaseFile;
    this.probe = options.probe ?? ((port, model) => this.probeServed(port, model));
    this.inspectTask = options.inspectTask;
    this.state = load(this.file);
    this.busy = false;
    this.restoring = null;
    this.recovery = null;
    this.ctx.on('session/event', (session, event) => {
      const lease = this.state.active;
      if (!lease || lease.phase !== 'running' || session.id !== lease.sessionId || event.type !== 'turn/end') return;
      void this.finish(lease.sequence).catch(() => undefined);
    });
    this.ctx.on('agent/status', ({ agent, status }) => {
      const lease = this.state.active;
      if (lease && agent.id === lease.sessionId && status !== 'running') {
        void this.finish(lease.sequence).catch(() => undefined);
      }
    });
  }

  current() { return this.state.active ? { sequence: this.state.active.sequence,
    phase: this.state.active.phase, model: this.state.active.model,
    runtimeGeneration: this.state.active.runtimeGeneration } : null; }

  persist() { save(this.file, this.state); }
  fenced(sequence) {
    const disk = load(this.file);
    if (disk.sequence !== sequence || disk.active?.sequence !== sequence
      || this.state.active?.sequence !== sequence) fail('D2C_STALE_LEASE', 'A newer selection lease owns the runtime');
    return this.state.active;
  }

  local() {
    const value = this.ctx.settings.get('local-llm');
    if (!value?.config || value.action || !['ready', 'stopped'].includes(value.status)) {
      fail('D2C_LOCAL_RUNTIME_BUSY', 'Local DSH model controller is not settled');
    }
    return value;
  }

  async noWriters() {
    if (this.ctx.agents.list().some((agent) => agent.status === 'running')) {
      fail('D2C_WRITER_CONFLICT', 'Another DSH session has an active writer');
    }
    const listed = await this.ctx.sessionController.list({});
    if (listed.items?.some((item) => item.running === true)) {
      fail('D2C_WRITER_CONFLICT', 'Another native DSH writer is active');
    }
  }

  async probeServed(port, model) {
    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    const response = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok || !response.ok) fail('D2C_SERVER_MISMATCH', 'Local model server is not healthy');
    const models = await response.json();
    if (!models.data?.some((item) => item.id === model)) {
      fail('D2C_SERVER_MISMATCH', 'Served local model differs from the requested model');
    }
  }

  async switchTo(sequence, target, configHash, { restartIfUnhealthy = false } = {}) {
    this.fenced(sequence);
    const before = this.local();
    if (hash(before.config) !== configHash) fail('D2C_CONFIG_CHANGED', 'DSH local model configuration changed during lease');
    if (before.status === 'ready' && before.slot === target.slot && before.mode === target.mode
      && before.preset === target.preset) {
      try {
        await this.probe(before.config.port, target.model);
        return;
      } catch (error) {
        if (!restartIfUnhealthy || error?.code !== 'D2C_SERVER_MISMATCH') throw error;
        // The saved slot is selected but its server is unhealthy. Use the
        // controller's native restart action to restore the snapshotted model.
      }
    }
    await this.noWriters();
    const entry = this.ctx.settings.describe({ redactSecrets: true }).find((item) => item.ns === 'local-llm');
    if (entry?.revision === undefined) fail('D2C_CONTROLLER_UNAVAILABLE', 'DSH local model settings revision is unavailable');
    let sawTransition = false;
    const controller = new AbortController();
    const settled = waitFor(this.ctx, 'settings/updated', (ns, value) => {
      if (ns !== 'local-llm') return undefined;
      if (value.status === 'error') fail('D2C_SWITCH_FAILED', 'DSH local model controller rejected the switch');
      if (value.status !== 'ready') sawTransition = true;
      if (sawTransition && value.status === 'ready' && value.slot === target.slot
        && value.mode === target.mode && value.preset === target.preset) return true;
      return undefined;
    }, 420000, 'D2C_SWITCH_TIMEOUT', controller.signal);
    try {
      await this.ctx.settings.mutate('local-llm', [
        { op: 'set', path: ['slot'], value: target.slot },
        { op: 'set', path: ['mode'], value: target.mode },
        { op: 'set', path: ['preset'], value: target.preset },
        { op: 'set', path: ['action'], value: before.status === 'ready' ? 'restart' : 'start' },
      ], entry.revision);
      await settled;
    } finally {
      controller.abort();
      await settled.catch(() => undefined);
    }
    const after = this.local();
    if (hash(after.config) !== configHash) fail('D2C_CONFIG_CHANGED', 'DSH local model configuration changed during switch');
    await this.probe(after.config.port, target.model);
  }

  async validate(model, effort) {
    if (!['low', 'medium', 'high'].includes(effort)) fail('D2C_UNSUPPORTED_EFFORT', 'DSH effort is not supported');
    const catalog = await this.ctx.sessionController.modelCatalog();
    const group = catalog.groups?.find((item) => item.models?.some((entry) => entry.id === model));
    const entry = group?.models?.find((item) => item.id === model);
    if (!entry) fail('D2C_UNSUPPORTED_MODEL', 'Exact DSH model is not in the live catalog');
    if (!entry.reasoning?.efforts?.some((item) => item.id === effort)) {
      fail('D2C_UNSUPPORTED_EFFORT', 'Effort is not supported by the exact DSH model');
    }
    const local = this.local();
    const slot = slotCapabilities(local).find((item) => item.model === model);
    if (!slot) {
      fail('D2C_UNSUPPORTED_MODEL', 'Exact DSH model has no configured local controller slot');
    }
    return { catalog, local, slot, provider: group.id };
  }

  async execute(input) {
    const digest = hash({ root: input.root, sessionId: input.sessionId, requestId: input.requestId,
      text: input.text, model: input.model, effort: input.effort });
    const previous = this.state.active;
    if (previous?.sessionId === input.sessionId && previous.requestId === input.requestId) {
      if (previous.digest !== digest) fail('D2C_DUPLICATE_CONFLICT', 'Request ID belongs to different DSH content');
      return { accepted: !['dispatching', 'outcome_unknown', 'recovery_required'].includes(previous.phase),
        duplicate: true, sequence: previous.sequence,
        model: previous.model, effort: previous.effort, phase: previous.phase };
    }
    await this.ensureRecovered();
    if (this.busy || this.state.active && this.state.active.phase !== 'restored') {
      fail('D2C_LEASE_BUSY', 'A DSH selection lease is active or needs recovery');
    }
    this.busy = true;
    let sequence = null;
    try {
      await this.noWriters();
      const { catalog, local, slot, provider } = await this.validate(input.model, input.effort);
      if (local.status !== 'ready') fail('D2C_LOCAL_RUNTIME_BUSY', 'Local DSH model server is not ready');
      const snapshot = { default: selection(this.ctx.settings.get('agent-default-model')),
        slot: local.slot, mode: local.mode, preset: local.preset,
        status: local.status, model: local.config.slots?.[local.slot]?.alias ?? null };
      if (!snapshot.default.provider || !snapshot.default.model || !snapshot.model) {
        fail('D2C_SNAPSHOT_INVALID', 'Current DSH default and local slot cannot be snapshotted');
      }
      const item = { sequence: this.state.sequence + 1, runtimeGeneration: this.generation,
        sessionId: input.sessionId, requestId: input.requestId, digest, model: input.model,
        effort: input.effort, provider, root: input.root, phase: 'acquired',
        snapshot, configHash: hash(local.config), target: slot,
        createdAt: new Date().toISOString() };
      this.state = { schema: 1, sequence: item.sequence, active: item };
      sequence = item.sequence;
      this.persist();
      await this.switchTo(sequence, slot, item.configHash);
      this.fenced(sequence);
      const selected = await this.ctx.sessionController.selectModel({ sessionId: input.sessionId,
        provider, model: input.model, reasoningEffort: input.effort });
      if (selected.selected?.provider !== provider || selected.selected?.model !== input.model) {
        fail('D2C_MODEL_MISMATCH', 'Native controller selected a different model');
      }
      this.state.active.phase = 'selected';
      this.state.active.resolvedEffort = selected.selected.reasoningEffort ?? null;
      this.persist();
      await this.probe(local.config.port, input.model);
      const selectedDefault = selection(this.ctx.settings.get('agent-default-model'));
      if (selectedDefault.provider !== provider || selectedDefault.model !== input.model) {
        fail('D2C_MODEL_MISMATCH', 'Native DSH default changed before dispatch');
      }
      if (!selected.selected.reasoningEffort
        || selectedDefault.reasoningEffort !== selected.selected.reasoningEffort) {
        fail('D2C_EFFORT_MISMATCH', 'Native DSH effort changed before dispatch');
      }
      this.state.active.phase = 'dispatching';
      this.persist();
      const sent = await this.ctx.sessionController.prompt({ sessionId: input.sessionId,
        requestId: input.requestId, mode: 'followup', content: [{ type: 'text', text: input.text }] },
      new AbortController().signal);
      if (sent.accepted !== true) fail('D2C_NATIVE_ERROR', 'Native DSH did not accept the selected turn');
      this.fenced(sequence);
      this.state.active.phase = 'running';
      this.persist();
      void this.finish(sequence).catch(() => undefined);
      return { accepted: true, duplicate: false, sequence, model: input.model,
        effort: input.effort, resolvedEffort: selected.selected.reasoningEffort ?? null,
        profile: slot.profile, backend: slot.backend, contextWindow: slot.contextWindow };
    } catch (error) {
      if (sequence !== null) {
        const lease = this.state.active;
        if (lease?.phase === 'dispatching') {
          lease.phase = 'outcome_unknown'; this.persist();
        } else {
          await this.restore(sequence).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async finish(sequence) {
    const lease = this.state.active;
    if (!lease || lease.sequence !== sequence || !['running', 'outcome_unknown'].includes(lease.phase)) return;
    const task = await this.inspectTask(lease.root, lease.sessionId, lease.requestId);
    if (!task?.found || !task.terminal) return;
    if (this.ctx.agents.get(lease.sessionId)?.status === 'running') return;
    await this.restore(sequence);
  }

  async restore(sequence) {
    if (this.restoring) return this.restoring;
    this.restoring = this.restoreNow(sequence).finally(() => { this.restoring = null; });
    return this.restoring;
  }

  async restoreNow(sequence) {
    const lease = this.fenced(sequence);
    if (lease.phase === 'restored') return;
    try {
      await this.noWriters();
      const current = this.local();
      if (hash(current.config) !== lease.configHash) {
        fail('D2C_CONFIG_CHANGED', 'DSH model configuration changed; refusing to overwrite Desktop state');
      }
      const now = selection(this.ctx.settings.get('agent-default-model'));
      const expected = { provider: lease.provider, model: lease.model,
        reasoningEffort: lease.resolvedEffort ?? lease.effort };
      if (!equal(now, expected) && !equal(now, lease.snapshot.default)
        && !(now.provider === lease.provider && now.model === lease.model)) {
        fail('D2C_WRITER_CONFLICT', 'DSH default changed outside the selection lease');
      }
      lease.phase = 'restoring'; this.persist();
      await this.switchTo(sequence, { slot: lease.snapshot.slot, mode: lease.snapshot.mode,
        preset: lease.snapshot.preset, model: lease.snapshot.model }, lease.configHash,
      { restartIfUnhealthy: true });
      await this.ctx.settings.replace('agent-default-model', {
        provider: lease.snapshot.default.provider, model: lease.snapshot.default.model,
        ...(lease.snapshot.default.reasoningEffort === null ? {} : { reasoningEffort: lease.snapshot.default.reasoningEffort }),
      });
      const after = selection(this.ctx.settings.get('agent-default-model'));
      const local = this.local();
      if (!equal(after, lease.snapshot.default) || local.slot !== lease.snapshot.slot
        || local.mode !== lease.snapshot.mode || local.preset !== lease.snapshot.preset) {
        fail('D2C_RESTORE_FAILED', 'Exact original DSH selection was not restored');
      }
      await this.probe(local.config.port, lease.snapshot.model);
      this.fenced(sequence);
      lease.phase = 'restored'; lease.restoredAt = new Date().toISOString(); this.persist();
    } catch (error) {
      if (this.state.active?.sequence === sequence && load(this.file).sequence === sequence) {
        this.state.active.phase = 'recovery_required';
        this.state.active.failureCode = error?.code?.startsWith?.('D2C_') ? error.code : 'D2C_RESTORE_FAILED';
        this.persist();
      }
      throw error;
    }
  }

  async ensureRecovered() {
    if (this.recovery) return this.recovery;
    this.recovery = this.recover().finally(() => { this.recovery = null; });
    return this.recovery;
  }

  async recover() {
    const lease = this.state.active;
    if (!lease || lease.phase === 'restored') return;
    if (['running', 'outcome_unknown', 'dispatching'].includes(lease.phase)) {
      const task = await this.inspectTask(lease.root, lease.sessionId, lease.requestId);
      if (task?.found && !task.terminal) {
        fail('D2C_LEASE_BUSY', 'Prior DSH task is still active; selection lease remains fenced');
      }
    }
    await this.restore(lease.sequence);
  }
}
