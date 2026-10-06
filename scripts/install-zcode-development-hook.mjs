import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const requested = args[args.indexOf('--workspace') + 1];
if (!args.includes('--workspace') || !requested || !path.isAbsolute(requested)) throw Error('Explicit absolute --workspace required');
const root = fs.realpathSync(requested);
if (!['package.json', 'pyproject.toml', 'CODEX.md'].some(name => fs.existsSync(path.join(root, name)))) throw Error('Workspace project marker required');
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const targetDir = path.join(os.homedir(), '.zcode', 'hooks');
const target = path.join(targetDir, 'engineering-ai-permission.mjs');
const old = fs.readFileSync(target, 'utf8');
if (!old.includes('Engineering AI safety gate:') || !old.includes('export function handle(')) throw Error('Existing hook ownership not recognized');
const source = fs.readFileSync(path.join(repo, 'integrations/zcode-development-hook/engineering-ai-permission.mjs'), 'utf8');
function atomic(file, content) {
  const temp = `${file}.tmp-${randomUUID()}`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
const backup = `${target}.before-${createHash('sha256').update(old).digest('hex').slice(0, 12)}`;
if (!fs.existsSync(backup)) fs.writeFileSync(backup, old, { flag: 'wx', mode: 0o600 });
const executionOutputRoot = fs.realpathSync(path.join(os.homedir(), '.zcode', 'cli', 'exec'));
const mappingFile = path.join(targetDir, 'engineering-ai-permission.json');
const previousMapping = fs.existsSync(mappingFile) ? JSON.parse(fs.readFileSync(mappingFile, 'utf8')) : {};
const readonlyDocuments = new Set(previousMapping.readonlyDocuments ?? []);
for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--read-document') continue;
  const file = args[++i];
  if (!file || !path.isAbsolute(file)) throw Error('Explicit absolute --read-document required');
  const canonical = fs.realpathSync(file);
  if (!canonical.endsWith('.md') || !fs.statSync(canonical).isFile() || fs.statSync(canonical).size > 5 * 1024 * 1024 || /(?:^|[\\/])(?:\.git|\.zcode|\.codex|\.ssh|\.env)(?:[\\/]|$)|credentials?|secrets?|passwords?|private[-_]?keys?/i.test(canonical)) throw Error('Only ordinary bounded Markdown documents can be authorized');
  readonlyDocuments.add(canonical);
}
if (readonlyDocuments.size > 8) throw Error('At most eight operator-authorized documents');
atomic(mappingFile, JSON.stringify({ schema: 1, workspaceRoot: root, executionOutputRoot, readonlyDocuments: [...readonlyDocuments] }, null, 2));
if (source !== old) atomic(target, source);
// Reuse the existing user-level hook engine. Add only output projection for
// the same owned hook; never change existing permission events or settings.
const cliConfigPath = path.join(os.homedir(), '.zcode', 'cli', 'config.json');
const cliBytes = fs.readFileSync(cliConfigPath, 'utf8');
const cliConfig = JSON.parse(cliBytes);
if (cliConfig.hooks?.enabled !== true || !cliConfig.hooks.events) throw Error('Existing enabled hook registry required');
let registrationChanged = false;
for (const event of ['PostToolUse', 'PostToolUseFailure']) {
  const groups = cliConfig.hooks.events[event] ?? [];
  if (!Array.isArray(groups)) throw Error('Invalid existing hook event');
  if (!groups.some(group => group.hooks?.some(h => h.type === 'process' && path.resolve(h.args?.[0] ?? '') === path.resolve(target) && h.args?.[1] === event))) {
    groups.push({ hooks: [{ type: 'process', command: process.execPath, args: [target, event], timeoutMs: 10000 }] });
    cliConfig.hooks.events[event] = groups;
    registrationChanged = true;
  }
}
if (registrationChanged) {
  if (fs.readFileSync(cliConfigPath, 'utf8') !== cliBytes) throw Error('Hook registry changed concurrently; operator retry required');
  const backupConfig = `${cliConfigPath}.before-${createHash('sha256').update(cliBytes).digest('hex').slice(0, 12)}`;
  if (!fs.existsSync(backupConfig)) fs.writeFileSync(backupConfig, cliBytes, { flag: 'wx', mode: 0o600 });
  atomic(cliConfigPath, JSON.stringify(cliConfig, null, 2));
}
console.log(JSON.stringify({ installed: true, workspace: root, sourceHash: createHash('sha256').update(source).digest('hex'), previousPreserved: true, hookRegistrationChanged: registrationChanged, providerRestartRequired: registrationChanged }));
