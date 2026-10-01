import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { ProviderSendOptions } from "../types.js";

type Grant = NonNullable<ProviderSendOptions["executionGrant"]>;
const sensitive = /(?:^|[\\/\s])(?:\.env(?:\.[^\\/\s]+)?|\.git|\.npmrc|\.netrc|\.pypirc|\.ssh|\.aws|\.azure|\.config|\.zcode|\.codex|\.cloudflared|credentials?(?:\.[^\\/\s]+)?|security\.json|auth\.json|cookies?)(?:$|[\\/\s])|(?:token|api[_-]?key|password|secret)\s*[=:]/i;

/** Resolve existing ancestors too: a new file beneath an escaping symlink is outside. */
function contained(root: string, raw: string, machineLocal = false): boolean {
  if (!raw || raw.includes("\0") || sensitive.test(raw)) return false;
  if (/^[\\/]{2}/.test(raw) || /^[a-z]:[^\\/]/i.test(raw) || raw.replace(/^[a-z]:/i, "").includes(":")) return false;
  const target = resolve(root, raw);
  // Machine-local grants do not admit UNC/network paths or device namespaces.
  if (machineLocal && /^[\\/]{2}/.test(target)) return false;
  let ancestor = target;
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
  const actual = resolve(realpathSync(ancestor), relative(ancestor, target));
  if (sensitive.test(actual)) return false;
  if (machineLocal) return !/^[\\/]{2}/.test(actual);
  const rel = relative(realpathSync(root), actual);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Deliberately small command grammar, not a general-purpose shell sandbox.
 * Workspace scripts are trusted development code under the admitted write grant.
 * No inline code, shell substitution, environment overrides, or arbitrary flags.
 */
function commandAllowed(command: string, root: string): boolean {
  if (command.length > 4096 || /[\r\n;&|<>`$*?{}\[\]~!%]/.test(command) || sensitive.test(command)) return false;
  const words = command.match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g);
  if (!words || words.join(" ") !== command.trim().replace(/\s+/g, " ")) return false;
  const args = words.map(w => w.replace(/^(["'])(.*)\1$/, "$2"));
  const [exe, first, ...rest] = args;
  if (exe === "node" && (first === "--version" || first === "-v")) return rest.length === 0;
  if (exe === "pnpm" && (first === "--version" || first === "-v")) return rest.length === 0;
  if (exe === "git") return rest.length === 0 && (first === "status" || first === "diff");
  if (exe === "pnpm" && ["test", "build", "typecheck"].includes(first ?? "")) return rest.length === 0;
  if (exe === "node" && first && /\.(?:mjs|cjs|js)$/.test(first) && contained(root, first)) {
    // Only workspace-local file arguments / simple literal words. No runtime flags.
    return rest.every(arg => !arg.startsWith("-") && /^[\w./\\-]+$/.test(arg) && contained(root, arg));
  }
  return false;
}

/**
 * Sanitized denial reason codes for callback decisions. These are POLICY
 * auto-denials computed by this module — never a human verdict — and carry
 * no command contents or sensitive values, only the classification.
 */
export type DevelopmentDenialReason =
  | "malformed-request"
  | "missing-active-grant"
  | "unsupported-risk-level"
  | "unsupported-decision-option"
  | "unsupported-tool"
  | "unsupported-input"
  | "outside-authorized-workspace"
  | "write-not-granted"
  | "sandbox-disable-denied"
  | "background-disallowed"
  | "unsupported-command";

export interface DevelopmentDecision {
  allowed: boolean;
  /** Null when allowed; one of DevelopmentDenialReason when denied. */
  reason: DevelopmentDenialReason | null;
}

/** Classify a reverse permission request against the active grants. The
 * decision is IDENTICAL to permitsDevelopmentOperation (same checks, same
 * order); only the reason classification is added. */
export function classifyDevelopmentOperation(params: unknown, grants: ReadonlyMap<string, Grant>): DevelopmentDecision {
  const deny = (reason: DevelopmentDenialReason): DevelopmentDecision => ({ allowed: false, reason });
  if (!params || typeof params !== "object") return deny("malformed-request");
  const p = params as Record<string, unknown>;
  if (typeof p.sessionId !== "string" || typeof p.requestId !== "string" || typeof p.toolCallId !== "string") return deny("malformed-request");
  const grant = grants.get(p.sessionId);
  if (!grant) return deny("missing-active-grant");
  if (!["low", "medium", "high"].includes(String(p.riskLevel))) return deny("unsupported-risk-level");
  if (!Array.isArray(p.options) || !p.options.some(o => o?.optionId === "allow_once" && o.kind === "allow_once" && o.response?.decision === "allow")) return deny("unsupported-decision-option");
  if (!p.input || typeof p.input !== "object" || Array.isArray(p.input)) return deny("unsupported-input");
  const input = p.input as Record<string, unknown>;
  const machineLocal = grant.write && grant.mode === "machine-local-development";
  try {
    if (["Glob", "Grep"].includes(String(p.toolName))) {
      if (p.toolName === "Glob" && typeof input.pattern === "string" &&
          (isAbsolute(input.pattern) || input.pattern.split(/[\\/]/).includes(".."))) return deny("outside-authorized-workspace");
      return contained(grant.workspacePath, typeof input.path === "string" ? input.path : grant.workspacePath, machineLocal)
        ? { allowed: true, reason: null }
        : deny("outside-authorized-workspace");
    }
    if (["Read", "Write", "Edit"].includes(String(p.toolName))) {
      if (p.toolName !== "Read" && !grant.write) return deny("write-not-granted");
      if (typeof input.file_path !== "string") return deny("unsupported-input");
      return contained(grant.workspacePath, input.file_path, machineLocal)
        ? { allowed: true, reason: null }
        : deny("outside-authorized-workspace");
    }
    if (p.toolName === "Bash" && grant.write) {
      if (Object.keys(input).some(k => !["command", "description", "timeout", "run_in_background", "dangerouslyDisableSandbox"].includes(k))) return deny("unsupported-input");
      if (input.dangerouslyDisableSandbox) return deny("sandbox-disable-denied");
      if (input.run_in_background) return deny("background-disallowed");
      if (typeof input.command !== "string") return deny("unsupported-input");
      // This is an explicit local process grant, not a shell sandbox. Network
      // authorization remains with the separate deployment/network policy.
      const commandOk = machineLocal
        ? input.command.trim().length > 0 && !input.command.includes("\0")
        : commandAllowed(input.command, grant.workspacePath);
      return commandOk ? { allowed: true, reason: null } : deny("unsupported-command");
    }
  } catch { /* Invalid paths or deleted workspaces fail closed. */ }
  if (!["Glob", "Grep", "Read", "Write", "Edit", "Bash"].includes(String(p.toolName))) return deny("unsupported-tool");
  if (String(p.toolName) === "Bash") return deny("write-not-granted");
  return deny("outside-authorized-workspace");
}

export function permitsDevelopmentOperation(params: unknown, grants: ReadonlyMap<string, Grant>): boolean {
  return classifyDevelopmentOperation(params, grants).allowed;
}
