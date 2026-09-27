import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { loadJson, saveJsonAtomic } from "./util/fsjson.js";
import { FileAuditLog } from "./util/log.js";
import { WorkspaceRegistry } from "./core/workspaces/registry.js";
import { Persistence } from "./core/tasks/persistence.js";
import { TaskEngine } from "./core/tasks/engine.js";
import { ZcodeProvider } from "./providers/zcode/client.js";
import { DesktopZCodeProvider } from "./providers/zcode/desktop.js";
import { ZcodeOfficialProvider } from "./providers/zcode/official.js";
import { startMcpHttpServer } from "./mcp/server.js";
import type { AgentProvider } from "./providers/types.js";

interface AuthState {
  bearerToken: string;
}

function ensureAuthToken(stateDir: string): string {
  const path = join(stateDir, "auth.json");
  const existing = loadJson<AuthState>(path);
  if (existing?.bearerToken) return existing.bearerToken;
  const fresh: AuthState = { bearerToken: `z2c_${randomBytes(24).toString("hex")}` };
  saveJsonAtomic(path, fresh);
  console.error(`[z2c] generated new bearer token at ${path}`);
  return fresh.bearerToken;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const audit = new FileAuditLog(cfg.stateDir);
  const store = new Persistence(cfg.stateDir);
  const interrupted = store.reconcileOnRestart();
  if (interrupted.length > 0) {
    console.error(`[z2c] restart reconciliation: marked ${interrupted.length} running task(s) interrupted`);
  }
  const staleRegistrations = cleanupStaleDesktopAgentRegistrations(cfg.stateDir);
  if (staleRegistrations.length > 0) {
    console.error(`[z2c] removed ${staleRegistrations.length} stale desktop-agent registration(s): ${staleRegistrations.join(", ")}`);
  }

  const workspaces = WorkspaceRegistry.fromList(store.data.workspaces);
  // PoC registry: disposable test workspace + engineering-ai as metadata (never used for mutation tests).
  if (!existsSync(join(cfg.stateDir, "state.json")) || workspaces.toList().length === 0) {
    const testWs = join(process.cwd(), "test-workspace");
    workspaces.register("z2c-test", testWs, "Z2C disposable test workspace");
    store.data.workspaces = workspaces.toList();
    store.save();
  }

  const provider = await selectProvider(cfg);
  try {
    await provider.start();
  } catch (err) {
    console.error(`[z2c] provider failed to start: ${(err as Error).message}`);
    console.error("[z2c] failing closed — MCP tools will report PROVIDER_UNAVAILABLE");
  }

  const engine = new TaskEngine(cfg, provider, workspaces, store, audit);
  engine.startQueuedTasks();
  const token = ensureAuthToken(cfg.stateDir);

  const { close } = await startMcpHttpServer(
    { engine, workspaces, store, provider, audit },
    cfg.host,
    cfg.port,
    token,
  );
  audit.record("info", "server.started", {
    host: cfg.host,
    port: cfg.port,
    provider: provider.status,
    zcodeVersion: provider.providerVersion,
    interruptedTasks: interrupted.length,
  });
  console.error(`[z2c] bridge listening on http://${cfg.host}:${cfg.port}/mcp (local only)`);
  console.error(`[z2c] provider: ${provider.status} (ZCode ${provider.providerVersion ?? "?"})`);

  const shutdown = async (): Promise<void> => {
    audit.record("info", "server.stopping", {});
    await close();
    await provider.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

/**
 * Remove desktop-agent registration files whose recorded PID is dead. The
 * proxy normally unlinks its own file on exit, but a hard kill (crash, reboot,
 * SIGKILL) leaves stale files behind. Liveness is re-proven per file so a live
 * registration is never removed; anything unparseable is left untouched.
 */
function cleanupStaleDesktopAgentRegistrations(stateDir: string): string[] {
  const dir = join(stateDir, "desktop-agents");
  if (!existsSync(dir)) return [];
  const removed: string[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith("agent-") || !file.endsWith(".json")) continue;
      const path = join(dir, file);
      try {
        const reg = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
        if (typeof reg.pid !== "number" || !Number.isInteger(reg.pid)) continue;
        try {
          process.kill(reg.pid, 0);
        } catch {
          try { unlinkSync(path); removed.push(file); } catch { /* best effort */ }
        }
      } catch { /* not ours to judge */ }
    }
  } catch { /* best effort cleanup must never block startup */ }
  return removed;
}

/**
 * Provider selection policy (Phase 2):
 *  - "official" is the DEFAULT and production path: Z2C spawns the
 *    open-source `zcode app-server --stdio` itself; ZCode resolves provider
 *    auth natively in-process.
 *  - Legacy lanes ("desktop-legacy", "headless") are EXPLICIT opt-in via
 *    Z2C_PROVIDER. An official-path failure is NEVER silently downgraded:
 *    startup surfaces the error (fail closed) so a security/attestation
 *    problem can masquerade as nothing.
 */
async function selectProvider(cfg: ReturnType<typeof loadConfig>): Promise<AgentProvider> {
  if (cfg.providerMode === "desktop-legacy") {
    console.error("[z2c] provider mode: desktop-legacy (EXPLICIT opt-in; model auth is Desktop-managed)");
    return new DesktopZCodeProvider(cfg);
  }
  if (cfg.providerMode === "headless") {
    console.error("[z2c] provider mode: headless (EXPLICIT opt-in; user-owned API key)");
    return new ZcodeProvider(cfg);
  }
  console.error("[z2c] provider mode: official (default; standalone app-server, ZCode-native auth)");
  return new ZcodeOfficialProvider(cfg);
}

main().catch((err) => {
  console.error("[z2c] fatal:", err);
  process.exit(1);
});
