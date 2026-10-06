// User-level ZCode hook. No permission-rule persistence, input rewriting, or plan bypass.
// This is a tool-input policy, NOT an OS sandbox. Tests/builds execute project code.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const win = path.win32;
// Operator-installed mapping, not a user path baked into executable policy.
const configPath = new URL('./engineering-ai-permission.json', import.meta.url);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (config.schema !== 1 || typeof config.workspaceRoot !== 'string') throw Error('Invalid hook workspace mapping');
const ROOT = normalize(config.workspaceRoot);
const EXEC_OUTPUT_ROOT = config.executionOutputRoot ? normalize(config.executionOutputRoot) : null;
const READ_DOCUMENTS = new Set((config.readonlyDocuments ?? []).map(p => normalize(p)));
const EVENTS = new Set(['PreToolUse', 'PermissionRequest']);
const OUTPUT_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const PASSIVE_TOOLS = new Set(['TodoWrite', 'TaskOutput', 'EnterPlanMode']);
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path'];
const blockedPart = /(?:^|[._-])(?:agents|claude|credentials?|secrets?|private[-_]?keys?|api[-_]?keys?|tokens?|passwords?|bridge|auth(?:entication|orization)?|oauth|registrations?|protected[-_]?continuation|c2c|z2c|permissions?|approvals?|safeguards?|security|policy|policies)(?:[._-]|$)/i;

function normalize(p, base) {
  if (typeof p !== 'string' || !p || /[\x00-\x1f%$`*?<>|]/.test(p)) throw Error('Ambiguous path');
  p = p.replaceAll('/', '\\');
  // Reject UNC/device namespaces, drive-relative paths, ADS, 8.3 aliases and Win32 aliases.
  if (p.startsWith('\\\\') || /^[a-z]:(?!\\)/i.test(p)) throw Error('Unsupported path');
  if (!/^[a-z]:\\/i.test(p)) {
    if (!base || p.startsWith('\\')) throw Error('Path must have a drive');
    p = win.join(base, p);
  }
  if (p.slice(2).includes(':')) throw Error('Alternate data stream');
  for (const part of p.slice(3).split('\\')) {
    if (part === '.' || part === '..' || !part) continue;
    if (/[ .]$|~\d/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw Error('Ambiguous Windows filename');
  }
  return win.normalize(p).replace(/\\+$/, '').toLowerCase();
}
function inside(p) { return p === ROOT || p.startsWith(ROOT + '\\'); }
function protectedPath(p) {
  return p.split('\\').some(part => blockedPart.test(part) || /bridge|auth|registr|protected[-_]?continuation|approval|permission/i.test(part) ||
    /^\.(?:git|zcode|codex|claude|agents|ssh|aws|azure|gnupg|kube)(?:$|[._-])/i.test(part) ||
    /^\.?env(?:$|[._-])/i.test(part) || /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(part) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.gitconfig)$/i.test(part));
}
// Read policy intentionally permits instruction files and ordinary policy/security docs.
// Keep the stricter, existing write/command matcher unchanged.
function protectedReadPath(p) {
  return p.split('\\').some(part =>
    /(?:^|[._-])(?:credentials?|secrets?|private[-_]?keys?|api[-_]?keys?|tokens?|passwords?|c2c|z2c)(?:[._-]|$)/i.test(part) ||
    /bridge|auth(?!or(?!ization))|registr|protected[-_]?continuation|approval|permission/i.test(part) ||
    /^\.(?:git|zcode|codex|claude|agents|ssh|aws|azure|gnupg|kube)(?:$|[._-])/i.test(part) ||
    /^\.env/i.test(part) || /^env(?:$|[._-])/i.test(part) ||
    /\.(?:pem|key|p12|pfx|keystore|jks|kdbx)$/i.test(part) ||
    /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.pypirc|\.netrc|\.gitconfig)$/i.test(part));
}
function verifyPhysical(p, write = false) {
  // Walk existing ancestors: reject links/junctions, alias resolution, and hardlinked files.
  let current = win.parse(p).root;
  for (const part of p.slice(current.length).split('\\').filter(Boolean)) {
    current = win.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (e) { if (e.code === 'ENOENT') break; throw Error('Cannot inspect path'); }
    if (stat.isSymbolicLink()) throw Error('Linked paths are not approved');
    if (normalize(fs.realpathSync.native(current)) !== normalize(current)) throw Error('Path alias is not approved');
    if (stat.isFile() && stat.nlink > 1) throw Error(write ? 'Hardlinked writes are not approved' : 'Hardlinked reads are not approved');
  }
}
function checkPath(p, cwd, write) {
  const resolved = normalize(p, cwd);
  if (!inside(resolved) && (write || !READ_DOCUMENTS.has(resolved))) throw Error('File target must remain inside project');
  if (write && resolved === ROOT) throw Error('Write target must be a project file');
  verifyPhysical(resolved, write);
  if (write ? protectedPath(resolved) : protectedReadPath(resolved)) throw Error('Protected path');
  return resolved;
}
function projectExecutionOutput(input, event) {
  if ((input.tool_name ?? input.toolName) !== 'Bash') return undefined;
  if (!['edit', 'build', 'accept-edits'].includes(input.permission_mode ?? input.mode)) return undefined;
  const session = input.session_id ?? input.sessionId;
  if (input.session_id && input.sessionId && input.session_id !== input.sessionId) throw Error('Conflicting session identities');
  if (process.env.ZCODE_SESSION_ID && process.env.ZCODE_SESSION_ID !== session) throw Error('Session identity mismatch');
  const call = input.tool_use_id ?? input.toolCallId;
  if (input.tool_use_id && input.toolCallId && input.tool_use_id !== input.toolCallId) throw Error('Conflicting tool call identities');
  if (!EXEC_OUTPUT_ROOT || !/^sess_[0-9a-f-]{36}$/i.test(session ?? '') || !/^call_[a-z0-9_-]{1,128}$/i.test(call ?? '')) throw Error('Missing execution output identity');
  const projected = [];
  for (const stream of ['stdout', 'stderr']) {
    const source = win.join(EXEC_OUTPUT_ROOT, session.toLowerCase(), `${call}-${stream}.log`);
    if (!fs.existsSync(source)) continue;
    verifyPhysical(source, false);
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw Error('Execution output exceeds bound');
    const relative = win.join('var', 'development', 'command-outputs', session.toLowerCase(), `${call}-${stream}.log`);
    const target = checkPath(relative, ROOT, true);
    fs.mkdirSync(win.dirname(target), { recursive: true });
    verifyPhysical(target, true);
    if (fs.existsSync(target)) {
      const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (digest(source) !== digest(target)) throw Error('Existing execution output differs');
    } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    projected.push(relative.replaceAll('\\', '/'));
  }
  if (!projected.length) return undefined;
  return { hookSpecificOutput: { hookEventName: event, additionalContext:
    `This command's complete output is available through workspace Read/Grep at: ${projected.join(', ')}. Read these projected artifacts instead of the native storage path. Command outcome is unchanged.` } };
}
function checkFileInput(input, cwd) {
  let found = false;
  for (const key of PATH_KEYS) if (input[key] !== undefined) {
    checkPath(input[key], cwd, true); found = true;
  }
  if (!found) throw Error('Missing write target');
  if (Array.isArray(input.edits)) for (const edit of input.edits) {
    for (const key of PATH_KEYS) if (edit[key] !== undefined) checkPath(edit[key], cwd, true);
  }
}
function checkPatch(input, cwd) {
  const patch = typeof input === 'string' ? input : input.patch ?? input.input;
  if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch\n') || !patch.trimEnd().endsWith('*** End Patch')) throw Error('Unsupported patch format');
  let count = 0;
  for (const line of patch.split('\n')) {
    if (/^\*\*\* (?:Delete File|Move to):/.test(line)) throw Error('Patch deletion or move is blocked');
    const m = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (m) { checkPath(m[1], cwd, true); count++; }
  }
  if (!count) throw Error('Missing patch targets');
}
function tokens(command) {
  // Single simple command only. No scripts, pipelines, redirection, variables or wrappers.
  if (typeof command !== 'string' || !command || command.length > 16000 || /[\x00-\x1f;&|<>$`%!{}()]/.test(command)) throw Error('Shell composition or expansion is blocked');
  const result = [];
  const re = /"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"']+)/gy;
  let pos = 0;
  while (pos < command.length) {
    while (/\s/.test(command[pos] ?? '') && pos < command.length) pos++;
    if (pos === command.length) break;
    re.lastIndex = pos;
    const m = re.exec(command);
    if (!m || (re.lastIndex < command.length && !/\s/.test(command[re.lastIndex]))) throw Error('Unparsed shell syntax');
    result.push(m[1] ?? m[2] ?? m[3]); pos = re.lastIndex;
  }
  if (!result.length) throw Error('Empty command');
  return result;
}
function localArgument(arg, cwd) {
  const candidate = arg.replace(/^--?[^=]+=/, '');
  if (/^[a-z]:|[\\/]|^\.\./i.test(candidate)) {
    // Glob metacharacters cannot safely establish a write boundary.
    const resolved = checkPath(candidate, cwd, false);
    if (!inside(resolved)) throw Error('Command path must remain inside project');
  }
}
function checkCommand(input, cwd) {
  if (input.dangerouslyDisableSandbox) throw Error('Sandbox override is blocked');
  const t = tokens(input.command);
  const command = t.shift().toLowerCase();
  // Only bare executable names. Do not execute an arbitrary path masquerading as a utility.
  let exe = command.replace(/\.exe$/, '');
  if (!/^[a-z][a-z0-9.-]*$/.test(command)) {
    const interpreter = checkPath(command, cwd, false);
    const rel = win.relative(ROOT, interpreter).replaceAll('\\', '/');
    if (!/^(?:apps\/api\/)?\.venv\/scripts\/python(?:\.exe)?$/.test(rel) || !fs.statSync(interpreter).isFile()) throw Error('Executable paths and wrappers are blocked');
    exe = 'python';
  }
  for (const a of t) {
    if (/^(?:https?|ftp|ssh|s3|gs):|^\\\\|^\/\//i.test(a)) throw Error('Remote transport is blocked');
    if (/(?:^|[\\/])(?:\.git|\.zcode|\.codex|\.ssh)(?:[\\/]|$)/i.test(a) || protectedPath(a)) throw Error('Protected command target');
  }
  if (exe === 'git') {
    const verb = t.shift();
    if (!['status', 'diff', 'log', 'show', 'ls-files', 'rev-parse'].includes(verb)) throw Error('Only inspection git commands are approved');
    for (const a of t) {
      if (/^--(?:output|ext-diff|textconv|exec|config|git-dir|work-tree|paginate)|^-c$|^-C$/.test(a)) throw Error('Unsafe git option');
      if (a.startsWith('-') && !/^(?:--(?:short|stat|name-only|name-status|cached|staged|numstat|oneline|no-pager|no-ext-diff|no-textconv|porcelain(?:=v[12])?|show-toplevel|show-prefix|abbrev-ref|verify|quiet|check|exit-code|untracked-files(?:=(?:no|normal|all))?|max-count=\d+)|-[sbpU]\d*|-n\d+|--)$/.test(a)) throw Error('Unreviewed git option');
      if (!a.startsWith('-')) localArgument(a, cwd);
    }
    return;
  }
  if (['pwd', 'whoami'].includes(exe)) { if (t.length) throw Error('Unexpected arguments'); return; }
  if (exe === 'node') {
    if (t.length === 1 && ['--version', '-v'].includes(t[0])) return;
    if (t[0] && /\.(?:mjs|cjs|js)$/.test(t[0]) && !/\.(?:test|spec)\./.test(t[0])) {
      const script = checkPath(t[0], cwd, false);
      if (!fs.statSync(script).isFile()) throw Error('Verification script must exist');
      for (const a of t.slice(1)) {
        if (!/^[a-z0-9_.=:/\\-]+$/i.test(a)) throw Error('Unreviewed script argument');
        if (!a.startsWith('-')) localArgument(a, cwd);
      }
      return;
    }
    // Node's existing project test runner. Inline programs, loaders, imports,
    // arbitrary scripts and output flags remain denied.
    const flags = new Set(['--experimental-strip-types', '--test', '--test-only']);
    const files = [];
    for (const a of t) {
      if (a.startsWith('-')) { if (!flags.has(a)) throw Error('Unreviewed Node test option'); }
      else {
        if (!/\.(?:test|spec)\.(?:ts|js|mjs|cjs)$/.test(a)) throw Error('Node accepts only project test files');
        checkPath(a, cwd, false); files.push(a);
      }
    }
    if (!t.includes('--test') || !files.length) throw Error('Node requires explicit project tests');
    return;
  }
  if (['rg', 'ls', 'cat', 'head', 'tail', 'wc'].includes(exe)) {
    // No rg preprocessors, compressed-file helpers, symlink traversal, or arbitrary flags.
    for (const a of t) {
      if (a.startsWith('-') && !/^(?:--(?:files|hidden|line-number|count|files-with-matches|files-without-match|no-heading|glob|iglob|type|ignore-case|max-count|context|before-context|after-context|color=never)|-[nliwcqsaAhH]|-[ABCm]\d+|-g|-t|-e|--|-\d+)$/.test(a)) throw Error('Unreviewed read/search option');
      if (!a.startsWith('-')) localArgument(a, cwd);
    }
    return;
  }
  let runner = exe;
  if (['python', 'python3', 'py'].includes(exe)) {
    if (t.length === 1 && ['--version', '-V'].includes(t[0])) return;
    if (t[0] && /\.py$/i.test(t[0])) {
      const script = checkPath(t[0], cwd, false);
      if (!inside(script) || !fs.statSync(script).isFile()) throw Error('Verification script must be a workspace file');
      for (const a of t.slice(1)) {
        if (!/^[a-z0-9_.=:/\\-]+$/i.test(a)) throw Error('Unreviewed script argument');
        if (!a.startsWith('-')) localArgument(a, cwd);
      }
      return;
    }
    if (t.shift() !== '-m' || t.shift() !== 'pytest') throw Error('Only python -m pytest is approved');
    runner = 'pytest';
  }
  if (runner === 'pytest') {
    for (const a of t) {
      if (a.startsWith('-') && !/^(?:-[qvxsf]|-vv|--(?:collect-only|disable-warnings|strict-markers|strict-config|tb=(?:short|long|line|no)|maxfail=\d+)|--)$/.test(a)) throw Error('Unreviewed pytest option');
      if (!a.startsWith('-')) localArgument(a.split('::')[0], cwd);
    }
    return;
  }
  if (runner === 'tsc') {
    if (!t.includes('--noEmit')) throw Error('Direct tsc must use --noEmit');
    for (const a of t) {
      if (a.startsWith('-') && !['--noEmit', '--pretty', '--incremental', '--project', '-p'].includes(a)) throw Error('Unreviewed tsc option');
      if (!a.startsWith('-')) localArgument(a, cwd);
    }
    // Incremental builds may write a cache outside the declared target.
    if (t.includes('--incremental') && t[t.indexOf('--incremental') + 1] !== 'false') throw Error('Incremental output is blocked');
    return;
  }
  if (['npm', 'pnpm', 'yarn'].includes(exe)) {
    if (t.length === 1 && ['--version', '-v'].includes(t[0])) return;
    // Package routing selects a contained directory, not a shell cwd override.
    if (['--dir', '-C', '--prefix'].includes(t[0])) {
      const flag = t.shift();
      if ((flag === '--prefix' && exe !== 'npm') || !t[0]) throw Error('Invalid package directory option');
      const target = checkPath(t.shift(), cwd, false);
      if (!fs.statSync(target).isDirectory() || !fs.existsSync(win.join(target, 'package.json'))) throw Error('Package directory requires package.json');
    }
    if (t[0] === 'run') t.shift();
    const task = t.shift();
    if (!['test', 'typecheck', 'lint', 'build', 'dev'].includes(task) || t.length) throw Error('Only bounded local package tasks without extra arguments are approved');
    // Lifecycle scripts are trusted project code, not an OS security boundary.
    return;
  }
  throw Error('Command is not in the bounded development allowlist');
}
function evaluate(input, cwd) {
  const tool = input.tool_name ?? input.toolName;
  const args = input.tool_input ?? input.toolInput;
  if (!tool || args === null || args === undefined) throw Error('Missing tool input');
  if (input.tool_name && input.toolName && input.tool_name !== input.toolName) throw Error('Conflicting tool names');
  if (input.tool_input && input.toolInput && JSON.stringify(input.tool_input) !== JSON.stringify(input.toolInput)) throw Error('Conflicting tool inputs');
  if (['ApplyPatch', 'apply_patch'].includes(tool)) return checkPatch(args, cwd);
  if (typeof args !== 'object' || Array.isArray(args)) throw Error('Invalid tool arguments');
  for (const key of ['cwd', 'workdir', 'working_directory', 'workingDirectory']) if (args[key] !== undefined && normalize(args[key], cwd) !== cwd) throw Error('Tool cwd override is blocked');
  if (FILE_TOOLS.has(tool)) return checkFileInput(args, cwd);
  if (READ_TOOLS.has(tool)) {
    let base = cwd;
    let found = false;
    for (const key of PATH_KEYS) if (args[key] !== undefined) {
      const target = checkPath(args[key], cwd, false);
      if (found && target !== base) throw Error('Conflicting read targets');
      base = target; found = true;
    }
    if (tool === 'Read' && !found) throw Error('Missing read target');
    if (!found) checkPath(cwd, cwd, false);
    if (tool === 'Glob') {
      // Only relative glob syntax with no traversal, alternation, or character classes.
      // Validate literal prefixes physically and every pattern component for protected names.
      const pattern = args.pattern;
      if (typeof pattern !== 'string' || !pattern || /^[\\/]|:|[{}\[\]!(+@]/.test(pattern)) throw Error('Unbounded glob pattern');
      const parts = pattern.replaceAll('\\', '/').split('/');
      if (parts.some(part => !part || part === '..' || part === '.')) throw Error('Glob traversal is blocked');
      const literal = [];
      for (const part of parts) {
        if (/[*?]/.test(part)) break;
        literal.push(part);
      }
      if (literal.length) checkPath(literal.join('/'), base, false);
      const probe = parts.map(part => part.replace(/[*?]/g, '') || 'glob').join('/');
      checkPath(probe, base, false);
    }
    return;
  }
  if (tool === 'Bash' || tool === 'Shell' || tool === 'exec_command') return checkCommand(args, cwd);
  if (PASSIVE_TOOLS.has(tool)) return;
  // Includes remote/MCP tools, agents, interactive stdin, approval/plan-exit controls.
  throw Error('Unknown or unbounded tool is blocked');
}
function decision(event, behavior, reason) {
  if (event === 'PreToolUse') return { hookSpecificOutput: { hookEventName: event, permissionDecision: behavior, permissionDecisionReason: reason } };
  return { hookSpecificOutput: { hookEventName: event, decision: behavior === 'allow' ? { behavior } : { behavior, message: reason } } };
}
export function handle(input, expectedEvent) {
  let cwd;
  try { cwd = normalize(input?.cwd); }
  catch {
    const event = expectedEvent ?? input?.hook_event_name ?? input?.hookEventName;
    try { if (EVENTS.has(event) && inside(normalize(process.cwd()))) return decision(event, 'deny', 'Engineering AI safety gate: missing or ambiguous cwd'); } catch {}
    return undefined;
  }
  if (!inside(cwd)) return undefined;
  const event = expectedEvent ?? input.hook_event_name ?? input.hookEventName;
  if (OUTPUT_EVENTS.has(event)) {
    try {
      verifyPhysical(cwd);
      for (const actual of [input.hook_event_name, input.hookEventName]) if (actual !== undefined && actual !== event) throw Error('Conflicting hook event');
      return projectExecutionOutput(input, event);
    } catch { return { hookSpecificOutput: { hookEventName: event, additionalContext: 'EXECUTION_OUTPUT_PROJECTION_UNAVAILABLE: native command outcome is preserved; workspace output could not be safely projected.' } }; }
  }
  if (!EVENTS.has(event)) return undefined;
  try {
    verifyPhysical(cwd);
    for (const actual of [input.hook_event_name, input.hookEventName]) if (actual !== undefined && actual !== event) throw Error('Conflicting hook event');
    evaluate(input, cwd);
    // Never emits PreToolUse allow, updates permissions, changes inputs, or overrides plan.
    if (event === 'PermissionRequest' && (input.permission_mode ?? input.mode) !== 'plan') return decision(event, 'allow');
    return undefined;
  } catch (e) { return decision(event, 'deny', 'Engineering AI safety gate: ' + e.message); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let raw = '';
  try {
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error('Hook input exceeds limit');
    }
    const result = handle(JSON.parse(raw), process.argv[2]);
    if (result) process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // Malformed payload cannot receive an allow; deny only when process cwd is in scope.
    let scoped = false;
    try { scoped = inside(normalize(process.cwd())); } catch {}
    if (scoped) {
      const event = EVENTS.has(process.argv[2]) ? process.argv[2] : 'PreToolUse';
      process.stdout.write(JSON.stringify(decision(event, 'deny', 'Engineering AI safety gate: invalid hook input')) + '\n');
      process.exitCode = 2;
    }
  }
}
