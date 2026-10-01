import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DshSelectionLease, slotCapabilities } from './selection-lease.js';

const CRACK = 'Bonsai2-CRACK-PQ2.ninfer';
const GSQ = 'Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf';
const efforts = ['low', 'medium', 'high'];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lease-test-'));
  const models = path.join(dir, 'models');
  fs.mkdirSync(models);
  for (const name of [CRACK, GSQ, 'mmproj-test.gguf']) fs.writeFileSync(path.join(models, name), 'model');
  const rows = (flag, value) => [{ flag, value: String(value) }];
  const config = { port: 18200, slots: {
    a: { dir: models, file: GSQ, alias: GSQ, backend: 'kvmem', mmproj: 'mmproj-test.gguf',
      presets: { 'text:fast': rows('-c', 131072), 'vision:fast': rows('-c', 131072),
        'vision:long': rows('-c', 131072) } },
    b: { dir: models, file: CRACK, alias: CRACK, backend: 'ninfer', mmproj: null,
      presets: { 'text:fast': rows('--max-context', 262144) } },
  } };
  const local = { config, slot: 'b', mode: 'text', preset: 'fast', status: 'ready', action: null };
  let defaultModel = { provider: 'qqz-kvmem', model: CRACK };
  let agentStatus = 'idle';
  let foreignBusy = false;
  let task = { found: false, terminal: null };
  let mutations = 0;
  let replacements = 0;
  let prompts = 0;
  let failNextProbe = false;
  const bus = new EventEmitter();
  const ctx = {
    on: (name, listener) => { bus.on(name, listener); return () => bus.off(name, listener); },
    agents: {
      list: () => [{ id: 'owned', status: agentStatus }, ...(foreignBusy ? [{ id: 'desktop', status: 'running' }] : [])],
      get: () => ({ status: agentStatus }),
    },
    settings: {
      get: (name) => name === 'local-llm' ? local : defaultModel,
      describe: () => [{ ns: 'local-llm', revision: 1 }],
      mutate: async (_name, changes) => {
        mutations++;
        for (const item of changes) local[item.path[0]] = item.value;
        local.status = 'stopping'; local.action = null;
        bus.emit('settings/updated', 'local-llm', { ...local });
        await Promise.resolve();
        local.status = 'ready';
        defaultModel = { provider: 'qqz-kvmem', model: config.slots[local.slot].alias };
        bus.emit('settings/updated', 'local-llm', { ...local });
      },
      replace: async (_name, value) => { replacements++; defaultModel = { ...value }; },
    },
    sessionController: {
      list: async () => ({ items: foreignBusy ? [{ running: true }] : [] }),
      modelCatalog: async () => ({ default: defaultModel, groups: [{ id: 'qqz-kvmem', models: [CRACK, GSQ]
        .map((id) => ({ id, reasoning: { efforts: efforts.map((effort) => ({ id: effort })) } })) }] }),
      selectModel: async ({ model, provider, reasoningEffort }) => {
        const mapped = reasoningEffort === 'high' ? 'xhigh' : reasoningEffort;
        defaultModel = { provider, model, reasoningEffort: mapped };
        return { selected: { provider, model, reasoningEffort: mapped } };
      },
      prompt: async () => { prompts++; agentStatus = 'running'; task = { found: true, terminal: null }; return { accepted: true }; },
    },
  };
  const make = (generation = 'gen-1') => new DshSelectionLease(ctx, generation, {
    file: path.join(dir, 'lease.json'),
    probe: async (_port, model) => {
      if (failNextProbe) {
        failNextProbe = false;
        throw Object.assign(new Error('model server unavailable'), { code: 'D2C_SERVER_MISMATCH' });
      }
      assert.equal(config.slots[local.slot].alias, model);
    },
    inspectTask: async () => task,
  });
  const input = (model = CRACK, effort = 'low', requestId = 'd2c-' + 'a'.repeat(32)) => ({
    root: dir, sessionId: 'session-d2c-' + 'b'.repeat(32), requestId, text: 'A disposable test task', model, effort,
  });
  const end = async () => {
    task = { found: true, terminal: { reason: 'completed' } };
    agentStatus = 'idle';
    bus.emit('session/event', { id: input().sessionId }, { type: 'turn/end' });
    bus.emit('agent/status', { agent: { id: input().sessionId }, status: 'idle' });
    for (let i = 0; i < 100; i++) {
      if (JSON.parse(fs.readFileSync(path.join(dir, 'lease.json'), 'utf8')).active?.phase === 'restored') return;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.fail('lease did not restore after terminal event');
  };
  return { dir, config, local, ctx, make, input, end,
    failNextProbe: () => { failNextProbe = true; },
    getDefault: () => defaultModel, setDefault: (value) => { defaultModel = value; },
    setForeignBusy: (value) => { foreignBusy = value; },
    setPrompt: (fn) => { ctx.sessionController.prompt = fn; },
    setTask: (value) => { task = value; },
    counts: () => ({ mutations, replacements, prompts }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('configured GSQ projector and vision profiles determine image input', () => {
  const f = fixture();
  try {
    const slot = slotCapabilities(f.local).find((item) => item.model === GSQ);
    assert.deepEqual(slot.inputModalities, ['text', 'image']);
    assert.equal(slot.contextWindow, 131072);
    assert.equal(slot.profile, 'vision:fast');
    f.config.slots.a.mmproj = 'missing.gguf';
    assert.deepEqual(slotCapabilities(f.local).find((item) => item.model === GSQ).inputModalities, ['text']);
    assert.deepEqual(slotCapabilities(f.local).find((item) => item.model === CRACK).inputModalities, ['text']);
  } finally { f.cleanup(); }
});

test('unhealthy snapshotted server is restarted before exact default restoration', async () => {
  const f = fixture();
  try {
    const lease = f.make();
    await lease.execute(f.input(CRACK, 'low'));
    f.failNextProbe();
    await f.end();
    assert.equal(f.counts().mutations, 1);
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
    assert.equal(lease.current().phase, 'restored');
  } finally { f.cleanup(); }
});

test('read-only capability and lease observations do not mutate defaults', () => {
  const f = fixture();
  try {
    const lease = f.make();
    slotCapabilities(f.local);
    lease.current();
    assert.deepEqual(f.counts(), { mutations: 0, replacements: 0, prompts: 0 });
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
  } finally { f.cleanup(); }
});

for (const effort of efforts) test(`exact CRACK selection maps ${effort} and restores original default`, async () => {
  const f = fixture();
  try {
    const lease = f.make();
    const result = await lease.execute(f.input(CRACK, effort));
    assert.equal(result.model, CRACK);
    assert.equal(result.resolvedEffort, effort === 'high' ? 'xhigh' : effort);
    assert.equal(f.getDefault().reasoningEffort, result.resolvedEffort);
    await f.end();
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
    assert.equal(f.counts().prompts, 1);
  } finally { f.cleanup(); }
});

test('GSQ selection switches to vision profile and restores exact original slot/default', async () => {
  const f = fixture();
  try {
    const lease = f.make();
    const result = await lease.execute(f.input(GSQ, 'high'));
    assert.equal(result.backend, 'kvmem');
    assert.equal(result.profile, 'vision:fast');
    assert.equal(f.local.slot, 'a');
    assert.equal(f.getDefault().model, GSQ);
    await f.end();
    assert.deepEqual({ slot: f.local.slot, mode: f.local.mode, preset: f.local.preset },
      { slot: 'b', mode: 'text', preset: 'fast' });
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
  } finally { f.cleanup(); }
});

test('unsupported exact model and effort refuse before any mutation', async () => {
  const f = fixture();
  try {
    const lease = f.make();
    await assert.rejects(() => lease.execute(f.input('not-a-model', 'low')),
      (error) => error.code === 'D2C_UNSUPPORTED_MODEL');
    await assert.rejects(() => lease.execute(f.input(CRACK, 'ultra')),
      (error) => error.code === 'D2C_UNSUPPORTED_EFFORT');
    assert.deepEqual(f.counts(), { mutations: 0, replacements: 0, prompts: 0 });
  } finally { f.cleanup(); }
});

test('effort drift after native selection refuses dispatch', async () => {
  const f = fixture();
  try {
    const select = f.ctx.sessionController.selectModel;
    f.ctx.sessionController.selectModel = async (input) => {
      const result = await select(input);
      f.setDefault({ ...f.getDefault(), reasoningEffort: 'medium' });
      return result;
    };
    await assert.rejects(() => f.make().execute(f.input(CRACK, 'low')),
      (error) => error.code === 'D2C_EFFORT_MISMATCH');
    assert.equal(f.counts().prompts, 0);
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
  } finally { f.cleanup(); }
});

test('unrelated native writer refuses lease acquisition', async () => {
  const f = fixture();
  try {
    f.setForeignBusy(true);
    await assert.rejects(() => f.make().execute(f.input()), (error) => error.code === 'D2C_WRITER_CONFLICT');
    assert.deepEqual(f.counts(), { mutations: 0, replacements: 0, prompts: 0 });
  } finally { f.cleanup(); }
});

test('duplicate request is idempotent; another request waits for the active lease', async () => {
  const f = fixture();
  try {
    const lease = f.make();
    await lease.execute(f.input());
    const duplicate = await lease.execute(f.input());
    assert.equal(duplicate.duplicate, true);
    assert.equal(f.counts().prompts, 1);
    await assert.rejects(() => lease.execute(f.input(GSQ, 'high', 'd2c-' + 'c'.repeat(32))),
      (error) => error.code === 'D2C_LEASE_BUSY');
    await assert.rejects(() => lease.execute(f.input(CRACK, 'medium')),
      (error) => error.code === 'D2C_DUPLICATE_CONFLICT');
    await f.end();
  } finally { f.cleanup(); }
});

test('ambiguous native prompt outcome is not replayed and terminal recovery restores default', async () => {
  const f = fixture();
  try {
    const lease = f.make();
    let attempts = 0;
    f.setPrompt(async () => { attempts++; f.setTask({ found: true, terminal: null });
      throw new Error('transport outcome lost'); });
    await assert.rejects(() => lease.execute(f.input(GSQ, 'high')), /transport outcome lost/);
    const retry = await lease.execute(f.input(GSQ, 'high'));
    assert.equal(retry.accepted, false);
    assert.equal(retry.phase, 'outcome_unknown');
    assert.equal(attempts, 1);
    f.setTask({ found: true, terminal: { reason: 'error' } });
    await lease.restore(retry.sequence);
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
  } finally { f.cleanup(); }
});

test('restart recovers an incomplete selected lease and old sequence is fenced', async () => {
  const f = fixture();
  try {
    const old = f.make('old-generation');
    f.setPrompt(async () => { throw new Error('before admission'); });
    await assert.rejects(() => old.execute(f.input(GSQ, 'low')), /before admission/);
    const stateFile = path.join(f.dir, 'lease.json');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    persisted.active.phase = 'selected';
    fs.writeFileSync(stateFile, JSON.stringify(persisted));
    const fresh = f.make('new-generation');
    await fresh.ensureRecovered();
    assert.equal(fresh.current().phase, 'restored');
    assert.deepEqual(f.getDefault(), { provider: 'qqz-kvmem', model: CRACK });
    const newer = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    newer.sequence += 1; newer.active.sequence = newer.sequence;
    fs.writeFileSync(stateFile, JSON.stringify(newer));
    await assert.rejects(() => old.restore(persisted.sequence), (error) => error.code === 'D2C_STALE_LEASE');
  } finally { f.cleanup(); }
});
