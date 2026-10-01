// Explicit opt-in sidecar; does not activate a release or change the public bridge.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStateDir } from '../src/config/paths.ts';
import { localWakeSecret, pendingWakes, startChatWake } from '../src/execution/chat-wake.ts';
const [workspace, owner] = process.argv.slice(2);
if (!workspace || !owner) throw new Error('Usage: pnpm exec tsx scripts/chat-wake.mjs <workspace-id> <owner-id>');
const state = fs.realpathSync(resolveStateDir());
const repo = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const relative = path.relative(repo, state);
if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Wake state must be outside the repository');
pendingWakes(state, workspace, owner); // validate before generating credentials
const dir = path.join(state, 'chat-wake', workspace);
const service = await startChatWake({ dir, secret: localWakeSecret(dir), pending: () => pendingWakes(state, workspace, owner) });
console.log('Chat wake listening on 127.0.0.1:47831. Import the external chat-wake/<workspace-id>/credential.json in extension options.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
