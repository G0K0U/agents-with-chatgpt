import assert from 'node:assert/strict';
import { taskView } from './index.js';

const requestId = 'd2c-' + 'a'.repeat(32);
const at = Date.now();
const event = (seq, type, data = {}) => ({ seq, type, data, time: at + seq });
const user = { content: [{ type: 'text', text: 'Create the test file' }],
  source: { kind: 'user', rpcId: requestId } };
const assistant = (text) => ({ message: { content: [{ type: 'text', text }],
  source: { provider: 'qqz-kvmem', model: 'Bonsai2-CRACK-PQ2.ninfer' } } });
const events = [
  event(0, 'turn/start', { turn: 1 }),
  event(1, 'user/message', user),
  event(2, 'assistant/message', assistant('I will use the file tool.')),
  event(3, 'tool/call'),
  event(4, 'tool/result'),
  event(5, 'assistant/message', assistant('The file is ready.')),
  event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
];
const ctx = { agents: { get: () => ({ status: 'running' }) } };
const inspected = { meta: { id: 'session-d2c-' + 'a'.repeat(32) }, events };
const before = taskView(ctx, { ...inspected, events: events.slice(0, 6) }, requestId);
assert.equal(before.terminal, null);
assert.equal(before.final, null);
const after = taskView(ctx, inspected, requestId);
assert.equal(after.terminal.reason, 'completed');
assert.equal(after.final.text, 'The file is ready.');
assert.equal(after.toolCalls, 1);
assert.equal(after.toolResults, 1);
assert.equal(after.events.length, 3);
const injected = { content: [{ type: 'text', text: 'Host context only' }],
  source: { kind: 'plugin' } };
const withInjected = taskView(ctx, { ...inspected, events: [
  ...events.slice(0, 2), event(2, 'user/message', injected),
  ...events.slice(2).map((entry) => ({ ...entry, seq: entry.seq + 1 })),
] }, requestId);
assert.equal(withInjected.writerConflict, false);
assert.equal(withInjected.events.length, 3);
const foreign = { content: [{ type: 'text', text: 'Interrupt the turn' }],
  source: { kind: 'user', rpcId: 'desktop-client' } };
assert.equal(taskView(ctx, { ...inspected, events: [
  ...events.slice(0, 6), event(6, 'user/message', foreign),
  event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
] }, requestId).writerConflict, true);
assert.equal(taskView(ctx, inspected, 'd2c-' + 'b'.repeat(32)).found, false);
console.log('Native terminal evidence tests passed');
