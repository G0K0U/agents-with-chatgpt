import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DshSelectionLease, slotCapabilities } from './selection-lease.js';

export const name = 'a2c-native-session-adapter';
export const inject = ['sessionController', 'agents', 'settings'];

const HOST = '127.0.0.1';
const PORT = 43190;
const MAX_BODY = 65536;
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh-beta');
const tokenPath = path.join(dshHome, 'd2c-adapter.token');
const sessionPattern = /^session-d2c-[0-9a-f]{32}$/;
const requestPattern = /^d2c-[0-9a-f]{32}$/;
const bonsaiLabels = [
  { index: 1, id: 'Bonsai2-PQ2-MTP.ninfer', before: 'Bonsai 2 27B + NInfer 256K', after: 'Bonsai 2 27B MTP + NInfer 256K' },
  { index: 4, id: 'Bonsai2-CRACK-PQ2.ninfer', before: 'Bonsai 2 27B + NInfer 256K', after: 'Bonsai 2 27B CRACK + NInfer 256K' },
];
const installedVersion = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).version; }
  catch { return 'unknown'; }
};
const appRoot = path.join(process.resourcesPath ?? '', 'app');
const dshVersion = installedVersion(path.join(appRoot, 'package.json'));
const harnessVersion = installedVersion(path.join(appRoot, 'node_modules',
  '@deepseek-ai', 'dsh-api-session-controller', 'package.json'));
const normalized = (value) => path.win32.normalize(fs.realpathSync.native(value)).replace(/[\\/]+$/, '').toLowerCase();
const sameRoot = (left, right) => normalized(left) === normalized(right);
const problem = (code, message) => Object.assign(new Error(message), { code });

function bearerToken() {
  try {
    const value = fs.readFileSync(tokenPath, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/.test(value)) throw problem('D2C_TOKEN_INVALID', 'Local adapter token is invalid');
    return value;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const value = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(tokenPath, value + '\n', { flag: 'wx', mode: 0o600 });
    try { fs.chmodSync(tokenPath, 0o600); } catch { /* Windows ACL inherits from DSH_HOME */ }
    return value;
  }
}

function safeText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  const text = parts.filter((part) => part?.type === 'text'
    && typeof part.text === 'string' && part.channel !== 'reasoning'
    && part.visibility !== 'hidden').map((part) => part.text).join('\n');
  return text.slice(0, 16000);
}

function fullVisibleText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === 'text' && typeof part.text === 'string'
      && part.channel !== 'reasoning' && part.visibility !== 'hidden')
    .map((part) => part.text).join('\n');
}

function visibleEvents(events, limit = 100) {
  const result = [];
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue;
    const message = event.type === 'user/message' ? event.data : event.data?.message;
    if (event.type === 'user/message' && message?.source?.kind !== 'user') continue;
    const text = safeText(message);
    if (!text) continue;
    result.push({ seq: event.seq, at: new Date(event.time).toISOString(),
      role: event.type === 'user/message' ? 'user' : 'assistant', text,
      requestId: event.type === 'user/message' && requestPattern.test(message?.source?.rpcId)
        ? message.source.rpcId : null,
      model: event.type === 'assistant/message' ? message?.source?.model ?? null : null,
      provider: event.type === 'assistant/message' ? message?.source?.provider ?? null : null });
  }
  return result.slice(-limit);
}

function lastSelection(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'request/header') {
      const config = event.data?.header?.config;
      if (config) return { provider: config.provider ?? null,
        model: config.model ?? null, reasoningEffort: config.reasoningEffort ?? null };
    }
  }
  return { provider: null, model: null, reasoningEffort: null };
}

function sessionView(ctx, inspected, limit = 100) {
  const { meta, events } = inspected;
  const live = ctx.agents.get(meta.id);
  return { sessionId: meta.id, cwd: meta.cwd, origin: meta.origin ?? null,
    createdAt: new Date(meta.createdAt).toISOString(),
    running: live?.status === 'running', status: live?.status ?? 'cold',
    lastSeq: events.at(-1)?.seq ?? -1, selection: lastSelection(events),
    messages: visibleEvents(events, limit) };
}

// A visible assistant message can precede tool calls and further model steps.
// Only the native turn/end event proves that the requested turn finished.
export function taskView(ctx, inspected, requestId) {
  const events = inspected.events;
  const userIndex = events.findIndex((event) => event.type === 'user/message'
    && event.data?.source?.rpcId === requestId);
  if (userIndex < 0) return { found: false, running: ctx.agents.get(inspected.meta.id)?.status === 'running' };
  const user = events[userIndex];
  const start = events.slice(0, userIndex + 1).findLast((event) => event.type === 'turn/start');
  if (!start || !Number.isInteger(start.data?.turn)) {
    throw problem('D2C_NATIVE_EVIDENCE_INVALID', 'Native turn start is unavailable');
  }
  const nextStart = events.findIndex((event, index) => index > userIndex && event.type === 'turn/start');
  const limit = nextStart < 0 ? events.length : nextStart;
  const endIndex = events.findIndex((event, index) => index > userIndex && index < limit
    && event.type === 'turn/end' && event.data?.turn === start.data.turn);
  const turnEvents = events.slice(userIndex, endIndex < 0 ? limit : endIndex);
  const assistant = [...turnEvents].reverse().find((event) => event.type === 'assistant/message'
    && safeText(event.data?.message));
  const header = events.slice(events.indexOf(start), endIndex < 0 ? limit : endIndex)
    .find((event) => event.type === 'request/header')?.data?.header?.config;
  const end = endIndex < 0 ? null : events[endIndex];
  const writerConflict = turnEvents.some((event) => event.seq > user.seq
    && event.type === 'user/message' && event.data?.source?.kind === 'user'
    && event.data?.source?.rpcId !== requestId);
  return {
    found: true, running: ctx.agents.get(inspected.meta.id)?.status === 'running',
    activeRequestId: events.findLast((event) => event.type === 'user/message'
      && event.data?.source?.kind === 'user')?.data?.source?.rpcId ?? null,
    userSeq: user.seq, userAt: new Date(user.time).toISOString(),
    promptSha256: crypto.createHash('sha256').update(fullVisibleText(user.data)).digest('hex'),
    writerConflict,
    served: header ? { provider: header.provider ?? null, model: header.model ?? null,
      reasoningEffort: header.reasoningEffort ?? null } : null,
    terminal: end ? { seq: end.seq, at: new Date(end.time).toISOString(),
      reason: end.data?.reason?.kind ?? 'unknown' } : null,
    final: end && assistant ? { seq: assistant.seq, at: new Date(assistant.time).toISOString(),
      text: safeText(assistant.data.message),
      model: assistant.data.message?.source?.model ?? null,
      provider: assistant.data.message?.source?.provider ?? null } : null,
    toolCalls: turnEvents.filter((event) => event.type === 'tool/call').length,
    toolResults: turnEvents.filter((event) => event.type === 'tool/result').length,
    events: visibleEvents(turnEvents, 20),
  };
}

async function inspectedInRoot(ctx, sessionId, root) {
  if (typeof sessionId !== 'string' || sessionId.length > 100) throw problem('D2C_BAD_SESSION', 'Session ID invalid');
  let inspected;
  try { inspected = await ctx.sessionController.inspect(sessionId); }
  catch { throw problem('D2C_SESSION_NOT_FOUND', 'Session is unavailable'); }
  if (!inspected?.meta?.cwd || !sameRoot(inspected.meta.cwd, root)) {
    throw problem('D2C_WORKSPACE_FORBIDDEN', 'Session is outside the authorized workspace');
  }
  if (inspected.meta.origin === 'subagent') throw problem('D2C_UNSUPPORTED', 'Subagent sessions are not controllable');
  return inspected;
}

function requireRequestId(value) {
  if (typeof value !== 'string' || !requestPattern.test(value)) {
    throw problem('D2C_BAD_REQUEST_ID', 'Request ID invalid');
  }
  return value;
}

function requireGeneration(input, generation) {
  if (input.generation !== generation) throw problem('D2C_STALE_GENERATION', 'DSH adapter restarted; refresh identity');
}

function requireRoot(input) {
  if (typeof input.workspaceRoot !== 'string' || !path.isAbsolute(input.workspaceRoot)) {
    throw problem('D2C_WORKSPACE_FORBIDDEN', 'Canonical workspace root required');
  }
  try { return fs.realpathSync.native(input.workspaceRoot); }
  catch { throw problem('D2C_WORKSPACE_FORBIDDEN', 'Workspace root is unavailable'); }
}

/** Bounded model-label change through DSH's settings service, without touching ids/defaults. */
export async function renameBonsaiLabels(ctx) {
  const entry = ctx.settings.describe({ redactSecrets: true }).find((item) => item.ns === 'llm-pi-ai');
  const models = entry?.user?.providers?.['qqz-kvmem']?.models;
  const resolved = entry?.value?.providers?.['qqz-kvmem']?.models;
  const selected = ctx.settings.get('agent-default-model');
  const catalogBefore = await ctx.sessionController.modelCatalog();
  if (!Array.isArray(models) || !Array.isArray(resolved)
    || selected?.provider !== 'qqz-kvmem' || selected?.model !== 'Bonsai2-CRACK-PQ2.ninfer'
    || catalogBefore.default?.provider !== selected.provider
    || catalogBefore.default?.model !== selected.model) {
    throw problem('D2C_LABEL_PRECONDITION', 'Bonsai settings/default precondition changed');
  }
  const next = structuredClone(models);
  for (const { index, id, before, after } of bonsaiLabels) {
    if (next[index]?.id !== id || resolved[index]?.id !== id
      || (next[index].name !== before && next[index].name !== after)) {
      throw problem('D2C_LABEL_PRECONDITION', 'Bonsai model identity/label changed');
    }
    next[index].name = after;
  }
  if (bonsaiLabels.some(({ index }) => models[index].name !== next[index].name)) {
    await ctx.settings.mutate('llm-pi-ai', [
      { op: 'set', path: ['providers', 'qqz-kvmem', 'models'], value: next },
    ], entry.revision);
  }
  const after = ctx.settings.get('agent-default-model');
  const catalogAfter = await ctx.sessionController.modelCatalog();
  if (after?.provider !== selected.provider || after?.model !== selected.model
    || catalogAfter.default?.provider !== selected.provider
    || catalogAfter.default?.model !== selected.model) {
    throw problem('D2C_LABEL_POSTCONDITION', 'Bonsai default changed');
  }
  return { provider: 'qqz-kvmem', labels: bonsaiLabels.map(({ index, id, after: name }) => ({ index, id, name })),
    default: { provider: after.provider, model: after.model } };
}

async function dispatch(ctx, input, generation, lease) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem('D2C_BAD_REQUEST', 'Object request required');
  if (input.op === 'health') return {
    adapter: 'dsh-a2c-native-session-adapter', version: '0.1.0',
    generation, hostPid: process.pid, dshVersion, harnessVersion,
    capabilities: { list: true, coldRead: true, create: true, attachOwned: true,
      send: true, task: true, cancelOwned: true, desktopControl: false,
      selectedTask: true, modelSelectionScope: 'transactional-global-lease',
      effortSelectionScope: 'task-under-lease', sessionLocalModelSelection: false,
      reason: 'Native selectModel also saves the global default' },
    selectionLease: lease.current(),
  };
  if (input.op === 'models') {
    const catalog = await ctx.sessionController.modelCatalog();
    const slots = slotCapabilities(ctx.settings.get('local-llm'));
    return { generation, default: catalog.default,
      groups: catalog.groups.slice(0, 50).map((group) => ({ id: group.id, name: group.name,
        models: group.models.slice(0, 100).map((model) => ({ id: model.id, name: model.name,
          reasoning: model.reasoning ?? null,
          ...(slots.find((slot) => slot.model === model.id) ?? {}) })) })) };
  }
  if (input.op === 'renameBonsaiLabels') {
    requireGeneration(input, generation);
    return { generation, ...await renameBonsaiLabels(ctx) };
  }
  const root = requireRoot(input);
  if (input.op === 'list') {
    const result = await ctx.sessionController.list({});
    const items = result.items.filter((item) => item.cwd && sameRoot(item.cwd, root))
      .slice(0, 200).map((item) => ({ sessionId: item.sessionId,
        cwd: item.cwd, origin: item.origin ?? null, updatedAt: new Date(item.updatedAt).toISOString(),
        running: item.running === true, blank: item.blank === true }));
    return { generation, items };
  }
  if (input.op === 'read') {
    const inspected = await inspectedInRoot(ctx, input.sessionId, root);
    return { generation, ...sessionView(ctx, inspected,
      Number.isInteger(input.limit) ? Math.max(1, Math.min(input.limit, 100)) : 50) };
  }
  if (input.op === 'task') {
    const requestId = requireRequestId(input.requestId);
    if (!sessionPattern.test(input.sessionId ?? '')) throw problem('D2C_UNSUPPORTED', 'Session is not D2C owned');
    const inspected = await inspectedInRoot(ctx, input.sessionId, root);
    return { generation, sessionId: input.sessionId, requestId,
      ...taskView(ctx, inspected, requestId) };
  }
  requireGeneration(input, generation);
  if (input.op === 'execute') {
    const requestId = requireRequestId(input.requestId);
    if (!sessionPattern.test(input.sessionId ?? '')) throw problem('D2C_UNSUPPORTED', 'Session is not D2C owned');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000) {
      throw problem('D2C_BAD_PROMPT', 'Prompt must be 1 to 20000 characters');
    }
    if (typeof input.model !== 'string' || !input.model || typeof input.effort !== 'string') {
      throw problem('D2C_BAD_SELECTION', 'Exact model and effort are required');
    }
    const inspected = await inspectedInRoot(ctx, input.sessionId, root);
    const latestUser = [...inspected.events].reverse().find((event) => event.type === 'user/message'
      && event.data?.source?.kind === 'user')?.data;
    if (latestUser && latestUser.source?.rpcId !== requestId
      && !requestPattern.test(latestUser.source?.rpcId ?? '')) {
      throw problem('D2C_WRITER_CONFLICT', 'A different writer has used this session');
    }
    const result = await lease.execute({ root, sessionId: input.sessionId, requestId,
      text: input.text, model: input.model, effort: input.effort });
    return { generation, sessionId: input.sessionId, requestId, ...result };
  }
  if (input.op === 'create') {
    requireRequestId(input.requestId);
    if (!sessionPattern.test(input.sessionId ?? '')) throw problem('D2C_BAD_SESSION', 'D2C session ID invalid');
    if (input.agentPreset !== undefined && input.agentPreset !== 'standard') {
      throw problem('D2C_BAD_PRESET', 'Only the standard acceptance preset is supported');
    }
    const result = await ctx.sessionController.create({ sessionId: input.sessionId, cwd: root,
      ...(input.agentPreset === 'standard' ? { agentPreset: 'standard' } : {}) });
    const inspected = await inspectedInRoot(ctx, result.sessionId, root);
    return { generation, sessionId: result.sessionId, cwd: inspected.meta.cwd,
      createdAt: new Date(inspected.meta.createdAt).toISOString() };
  }
  if (input.op === 'send') {
    if (lease.current() && lease.current().phase !== 'restored') {
      throw problem('D2C_LEASE_BUSY', 'Selected DSH task owns the runtime');
    }
    requireRequestId(input.requestId);
    if (!sessionPattern.test(input.sessionId ?? '')) throw problem('D2C_UNSUPPORTED', 'Session is not D2C owned');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20000) {
      throw problem('D2C_BAD_PROMPT', 'Prompt must be 1 to 20000 characters');
    }
    const inspected = await inspectedInRoot(ctx, input.sessionId, root);
    const latestUser = [...inspected.events].reverse().find((event) => event.type === 'user/message'
      && event.data?.source?.kind === 'user')?.data;
    const prior = inspected.events.find((event) => event.type === 'user/message'
      && event.data?.source?.rpcId === input.requestId);
    if (prior && safeText(prior.data) !== input.text) {
      throw problem('D2C_DUPLICATE_CONFLICT', 'Request ID already belongs to different content');
    }
    if (prior) return { generation, sessionId: input.sessionId, requestId: input.requestId, accepted: true, duplicate: true };
    if (latestUser && !requestPattern.test(latestUser.source?.rpcId ?? '')) {
      throw problem('D2C_WRITER_CONFLICT', 'A different writer has used this session');
    }
    if (ctx.agents.get(input.sessionId)?.status === 'running') {
      throw problem('D2C_BUSY', 'Session has an active writer');
    }
    const result = await ctx.sessionController.prompt({ sessionId: input.sessionId,
      requestId: input.requestId, mode: 'followup', content: [{ type: 'text', text: input.text }] },
    new AbortController().signal);
    return { generation, sessionId: input.sessionId, requestId: input.requestId,
      accepted: result.accepted === true, duplicate: false };
  }
  if (input.op === 'cancel') {
    const requestId = requireRequestId(input.requestId);
    if (!sessionPattern.test(input.sessionId ?? '')) throw problem('D2C_UNSUPPORTED', 'Session is not D2C owned');
    const inspected = await inspectedInRoot(ctx, input.sessionId, root);
    const latestUser = [...inspected.events].reverse().find((event) => event.type === 'user/message'
      && event.data?.source?.kind === 'user')?.data;
    if (latestUser?.source?.rpcId !== requestId) throw problem('D2C_NOT_OWNER', 'Task is not the active owned turn');
    if (ctx.agents.get(input.sessionId)?.status !== 'running') throw problem('D2C_NOT_RUNNING', 'No active task to cancel');
    const result = await ctx.sessionController.cancel({ sessionId: input.sessionId });
    return { generation, sessionId: input.sessionId, requestId, cancelled: result?.cancelled ?? true };
  }
  if (input.op === 'selectModel') throw problem('D2C_UNSUPPORTED', 'Native selectModel changes the global default');
  throw problem('D2C_UNSUPPORTED', 'Operation is not supported');
}

async function readBody(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw problem('D2C_TOO_LARGE', 'Request body too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem('D2C_BAD_JSON', 'JSON request required'); }
}

export function apply(ctx) {
  const token = bearerToken();
  const generation = crypto.randomUUID();
  const lease = new DshSelectionLease(ctx, generation, {
    inspectTask: async (root, sessionId, requestId) => {
      const inspected = await inspectedInRoot(ctx, sessionId, root);
      return taskView(ctx, inspected, requestId);
    },
  });
  void lease.ensureRecovered().catch((error) => {
    ctx.logger?.warn?.(`D2C selection lease recovery pending: ${error?.code ?? 'D2C_NATIVE_ERROR'}`);
  });
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    const remote = req.socket.remoteAddress;
    const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const valid = /^[0-9a-f]{64}$/.test(given)
      && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (remote !== '127.0.0.1' || !valid) return reply(401, { ok: false, error: { code: 'D2C_UNAUTHORIZED' } });
    if (req.method !== 'POST' || req.url !== '/rpc') return reply(404, { ok: false, error: { code: 'D2C_NOT_FOUND' } });
    try { return reply(200, { ok: true, data: await dispatch(ctx, await readBody(req), generation, lease) }); }
    catch (error) {
      const code = typeof error?.code === 'string' && error.code.startsWith('D2C_')
        ? error.code : 'D2C_NATIVE_ERROR';
      return reply(code === 'D2C_STALE_GENERATION' ? 409 : 400,
        { ok: false, error: { code, message: code === 'D2C_NATIVE_ERROR'
          ? 'Native DSH operation failed' : String(error.message).slice(0, 200) } });
    }
  });
  server.listen(PORT, HOST);
  server.on('error', (error) => {
    ctx.logger?.error?.(`D2C adapter listen failed: ${error?.code ?? 'unknown'}`);
  });
  ctx.effect(() => () => server.close(), 'd2c-adapter');
}
