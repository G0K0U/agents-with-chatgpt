import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { loadConfig } from "../config.js";
import { loadJson, saveJsonAtomic } from "../util/fsjson.js";
import { FileAuditLog } from "../util/log.js";
import { Persistence } from "../core/tasks/persistence.js";
import { WorkspaceRegistry } from "../core/workspaces/registry.js";
import { TaskEngine } from "../core/tasks/engine.js";
import { ZcodeOfficialProvider } from "../providers/zcode/official.js";
import { loadWorkspaceGrants } from "../authz/grants.js";
import { loadPairing } from "../authz/pairing.js";
import { loadSessionOwnership } from "../authz/ownership.js";
import { loadOrCreateSecurity } from "./security.js";
import { SessionService } from "./sessions.js";
import { buildZ2cService } from "./server.js";
import { Z2C_PROTOCOL_VERSION } from "../version.js";

/**
 * Z2C local service (daemon) entry: one long-running per-user process that
 * owns the ZCode app-server children, supervises them with bounded backoff,
 * cleans up orphans from hard crashes, and serves the loopback HTTP surfaces.
 * See docs/z2c-local-service.md for the full lifecycle contract.
 */

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];

interface ServicePidFile {
  version: 1;
  pid: number;
  installId: string;
  startedAt: number;
  port: number;
  protocolVersion: number;
}

interface ChildrenFile {
  version: 1;
  children: Array<{ pid: number; recordedAt: number }>;
}

export function pidFilePath(stateDir: string): string {
  return join(stateDir, "service.json");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when service.json points at a LIVE previous service instance. */
export function existingService(stateDir: string): ServicePidFile | null {
  const path = pidFilePath(stateDir);
  if (!existsSync(path)) return null;
  try {
    const pidFile = JSON.parse(readFileSync(path, "utf8")) as ServicePidFile;
    if (pidFile.version !== 1) return null;
    return isAlive(pidFile.pid) ? pidFile : null;
  } catch {
    return null;
  }
}

/**
 * Kill app-server children recorded by a PREVIOUS crashed run. Safety: a
 * recorded pid is only killed after confirming, via the OS, that the process
 * command line is really a zcode.cjs app-server child (pid-reuse guard).
 */
export async function cleanupOrphanChildren(stateDir: string): Promise<number> {
  const path = join(stateDir, "children.json");
  const recorded = loadJson<ChildrenFile>(path);
  if (!recorded || recorded.version !== 1 || !Array.isArray(recorded.children) || recorded.children.length === 0) return 0;
  let killed = 0;
  for (const child of recorded.children) {
    if (!isAlive(child.pid)) continue;
    const isZcodeChild = (cmd: string): boolean =>
      (cmd.includes("zcode.cjs") || cmd.includes("zcode.js") || cmd.includes("zcode")) && cmd.includes("app-server");
    const confirmed = await new Promise<boolean>((resolve) => {
      if (process.platform !== "win32") {
        try {
          const cmdline = readFileSync(`/proc/${child.pid}/cmdline`, "utf8");
          resolve(isZcodeChild(cmdline));
        } catch {
          resolve(false);
        }
        return;
      }
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}').CommandLine`],
        { timeout: 15000 },
        (err, stdout) => {
          if (err) return resolve(false);
          const line = String(stdout ?? "");
          resolve(isZcodeChild(line));
        },
      );
    });
    if (confirmed) {
      try {
        process.kill(child.pid);
        killed += 1;
      } catch { /* already gone */ }
    }
  }
  saveJsonAtomic(path, { version: 1, children: [] });
  return killed;
}

export interface RunningService {
  stop(): Promise<void>;
  port: number;
}

export async function startService(opts?: { port?: number }): Promise<RunningService> {
  const cfg = loadConfig();
  if (opts?.port) cfg.port = opts.port;
  const stateDir = cfg.stateDir;

  const previous = existingService(stateDir);
  if (previous) {
    throw new Error(`Z2C service is already running (pid ${previous.pid}); use 'z2c stop' first`);
  }
  const orphans = await cleanupOrphanChildren(stateDir);
  if (orphans > 0) console.error(`[z2c] cleaned up ${orphans} orphaned app-server child(ren) from a previous crash`);

  const audit = new FileAuditLog(join(stateDir, "audit"));
  const store = new Persistence(stateDir);
  store.reconcileOnRestart();
  const workspaces = WorkspaceRegistry.fromList(store.data.workspaces);
  const provider = new ZcodeOfficialProvider(cfg);
  const engine = new TaskEngine(cfg, provider, workspaces, store, audit);
  const security = loadOrCreateSecurity(stateDir);
  const grants = loadWorkspaceGrants(stateDir);
  const pairing = loadPairing(stateDir);
  const ownership = loadSessionOwnership(stateDir);
  const sessions = new SessionService({ provider, grants, ownership, audit });

  await provider.start();
  if (provider.status !== "healthy") {
    // Fail loudly: no silent degradation, no legacy downgrade.
    throw new Error(`official provider failed to start: ${provider.statusDetail ?? provider.status}`);
  }

  let stopping = false;
  let supervisionTimer: NodeJS.Timeout | undefined;
  let lastRestartAt = 0;
  let backoffIndex = 0;
  let shutdownPromise: Promise<void> | null = null;

  const recordChild = (): void => {
    const pid = provider.childPid;
    if (pid === null) return;
    saveJsonAtomic(join(stateDir, "children.json"), { version: 1, children: [{ pid, recordedAt: Date.now() }] });
  };
  recordChild();

  const restartProvider = async (): Promise<void> => {
    audit.record("warn", "service.provider_restart", { attempt: backoffIndex + 1, status: provider.status });
    try {
      await provider.stop();
      await provider.start();
      backoffIndex = 0;
      recordChild();
    } catch {
      backoffIndex = Math.min(backoffIndex + 1, BACKOFF_MS.length - 1);
    }
  };

  // Supervision: bounded-backoff restart of the official provider when it
  // degrades. No legacy downgrade, no unlimited spin.
  supervisionTimer = setInterval(() => {
    if (stopping || provider.status === "healthy") return;
    if (Date.now() - lastRestartAt >= BACKOFF_MS[backoffIndex]!) {
      lastRestartAt = Date.now();
      void restartProvider();
    }
  }, 10_000);

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    if (supervisionTimer) clearInterval(supervisionTimer);
    shutdownPromise = (async () => {
      audit.record("info", "service.stopping", {});
      service.httpServer.close();
      await service.close();
      await provider.stop().catch(() => undefined);
      try { saveJsonAtomic(join(stateDir, "children.json"), { version: 1, children: [] }); } catch { /* best effort */ }
      try { rmSync(pidFilePath(stateDir), { force: true }); } catch { /* best effort */ }
    })();
    return shutdownPromise;
  };

  const service = buildZ2cService({
    cfg,
    provider,
    engine,
    sessions,
    security,
    pairing,
    grants,
    ownership,
    audit,
    onShutdownRequest: () => void shutdown().then(() => process.exit(0)),
  });
  await new Promise<void>((resolve, reject) => {
    service.httpServer.once("error", (err) => reject(err));
    service.httpServer.listen(cfg.port, cfg.host, () => resolve());
  });

  const pidFile: ServicePidFile = { version: 1, pid: process.pid, installId: security.state.installId, startedAt: Date.now(), port: cfg.port, protocolVersion: Z2C_PROTOCOL_VERSION };
  saveJsonAtomic(pidFilePath(stateDir), pidFile);
  audit.record("info", "service.started", { port: cfg.port, protocolVersion: Z2C_PROTOCOL_VERSION, installId: security.state.installId, provider: provider.name });
  console.error(`[z2c] service listening on http://${cfg.host}:${cfg.port}/mcp (loopback; protocol v${Z2C_PROTOCOL_VERSION})`);

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

  return {
    stop: () => shutdown(),
    port: cfg.port,
  };
}

// Daemon bootstrap: when run directly, start and stay up.
const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const normalized = entry.replace(/\\/g, "/").toLowerCase();
  return normalized.endsWith("service/main.js") || normalized.endsWith("service/main.ts");
})();

if (isDirectRun) {
  startService().catch((err) => {
    console.error(`[z2c] service failed to start: ${(err as Error).message}`);
    process.exit(1);
  });
}
