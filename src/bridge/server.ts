import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { WorkspaceRegistry } from "../workspace/registry.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CodexTaskManagerPool } from "../execution/pool.js";
import { EngineeringAiAuditMaintainer } from "../execution/audit-maintenance.js";
import { startZcodeCoordinatorFromEnvironment, type ZcodeCoordinator } from "../execution/zcode-coordinator.js";
import { installApprovedManifest, manifestSchema } from "../execution/continuation.js";
import { executionOrchestrator, type ExecutionOrchestrator } from "../execution/orchestrator.js";
import type { OmnigentBackendOptions } from "../execution/omnigent.js";
import { C2CSessionRegistry } from "../session/registry.js";
import type { AppServerFactory } from "../execution/app-server.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { waitForPublicMcp, type PublicFetch, type PublicProbeResult } from "../tunnel/probe.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { reconcileUnknownWorkspaceSlots } from "../execution/slot.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT, resolveStateDir, writeSecureJson } from "../config/paths.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import { writeRuntimeState, clearRuntimeState, type RuntimeState } from "./runtime.js";
import { currentRuntimeDir, resolveRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity.js";
import {
  acquireStateDomainOwner,
  resolveOwnedAuthStorage,
  writeAuthStatePointer,
  type StateDomainOwner,
} from "./state-owner.js";
import type { BridgeProcessInspector } from "./runtime.js";

function tunnelForWorkspace(workspaceId: string, logger: Logger, stateDir: string): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId, stateDir));
  if (binding) {
    return new CloudflaredNamedTunnel({
      workspaceId,
      tunnelName: binding.tunnelName,
      tunnelId: binding.tunnelId,
      hostname: binding.hostname,
      logger,
      stateDir,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  /** One immutable state domain for the complete bridge generation. */
  stateDir?: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  /** Persist runtime state file (disable in tests). */
  persistRuntime?: boolean;
  authStoreFile?: string;
  workspaceRegistryFile?: string;
  sessionRegistryFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  /** Test seam; production uses the fixed official `codex app-server --stdio` client. */
  appServerFactory?: AppServerFactory;
  /** Local-only orchestration configuration; absent keeps legacy behavior. */
  orchestrator?: ExecutionOrchestrator;
  omnigent?: Omit<OmnigentBackendOptions, "stateDir">;
  /** Local full filesystem/process deployment; it is also the capability that may authorize task network opt-in. */
  fullAccess?: boolean;
  /** Local-only configured root of the named OneDrive account used by the fixed audit mirror. */
  oneDriveRoot?: string;
  /** Maximum number of waiting tasks per workspace; defaults to 50. */
  maxQueueSize?: number;
  /** Test seams for the strict public MCP verification gate. */
  publicFetch?: PublicFetch;
  publicProbeTimeoutMs?: number;
  publicProbeAttemptTimeoutMs?: number;
  publicProbeIntervalMs?: number;
  /** Production defaults to true; tests may explicitly opt into ownership. */
  enforceStateOwnership?: boolean;
  /** Test seam for process-identity fencing. */
  stateDomainProcessInspector?: BridgeProcessInspector;
  /** Test seam for injecting or mocking the Engineering AI audit maintainer. */
  auditMaintainer?: EngineeringAiAuditMaintainer;
  /** Start the C2C-owned ZCode scheduled-queue coordinator (default: enabled). */
  zcodeCoordinator?: boolean;
}

export interface Bridge {
  workspace: Workspace;
  registry: WorkspaceRegistry;
  sessions: C2CSessionRegistry;
  taskManagers: CodexTaskManagerPool;
  auditMaintainer?: EngineeringAiAuditMaintainer;
  zcodeCoordinator?: ZcodeCoordinator;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

const BRIDGE_REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Listen on the preferred port; on EADDRINUSE fall back to an ephemeral port.
 */
function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

async function startBridgeInternal(opts: BridgeOptions, stateOwner?: StateDomainOwner): Promise<Bridge> {
  const stateDir = stateOwner?.stateDir ?? resolveStateDir(opts.stateDir);
  const logger = opts.logger ?? nullLogger;
  const workspace = new Workspace(opts.workspaceRoot);
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }
  const registry = new WorkspaceRegistry({ file: opts.workspaceRegistryFile, stateDir });
  const bridgeRoot = new Workspace(BRIDGE_REPOSITORY_ROOT);
  const bootstrapEntries = [
    {
      name: workspace.id === bridgeRoot.id ? "c2c-bridge" : workspace.name,
      canonicalPath: workspace.root,
      id: workspace.id,
    },
  ];
  if (bridgeRoot.id !== workspace.id) {
    bootstrapEntries.push({ name: "c2c-bridge", canonicalPath: bridgeRoot.root, id: bridgeRoot.id });
  }
  registry.bootstrap(bootstrapEntries);
  const authorizedWorkspaceIds = registry.enabledIds().filter((workspaceId) => {
    try {
      registry.getWorkspace(workspaceId);
      return true;
    } catch (error) {
      logger.warn(`Ignoring unavailable registered workspace ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  });
  // Sweep locks for workspaces outside this authorized registry before lazy
  // task-manager recovery. Such managers are intentionally never constructed,
  // so those locks must be treated as missing-task ghosts at bridge startup.
  reconcileUnknownWorkspaceSlots(authorizedWorkspaceIds, stateDir);
  const authDir = path.join(stateDir, "auth");
  const canonicalAuthFile = opts.authStoreFile ?? path.join(authDir, "bridge.json");
  const configuredLegacyAuthFiles = opts.authStoreFile
    ? []
    : authorizedWorkspaceIds.map((workspaceId) => path.join(authDir, `${workspaceId}.json`));
  const ownedAuthStorage = stateOwner && !opts.authStoreFile
    ? resolveOwnedAuthStorage(stateOwner, {
        canonicalFile: canonicalAuthFile,
        legacyFiles: configuredLegacyAuthFiles,
      })
    : null;
  const authStoreFile = ownedAuthStorage?.file ?? canonicalAuthFile;
  const legacyAuthFiles = ownedAuthStorage?.legacyFiles ?? configuredLegacyAuthFiles;

  const authStore = new AuthStore(workspace.id, {
    file: authStoreFile,
    stateDir,
    legacyFiles: legacyAuthFiles,
    authorizedWorkspaceIds,
    migrateLegacyWorkspaceBindings: true,
    generationFence: stateOwner,
    legacyFilesReadOnly: Boolean(ownedAuthStorage),
  });
  if (stateOwner) {
    ensureOwnedAuthSnapshot(stateOwner, authStoreFile);
    writeAuthStatePointer(stateOwner);
  }
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger, stateDir);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  const sessions = new C2CSessionRegistry({ file: opts.sessionRegistryFile, stateDir });

  let auditMaintainer: EngineeringAiAuditMaintainer | undefined = opts.auditMaintainer;
  if (!auditMaintainer) {
    try {
      auditMaintainer = new EngineeringAiAuditMaintainer({
        stateDir,
        logger,
        registry,
        oneDriveRoot: opts.oneDriveRoot,
        fullAccess: opts.fullAccess === true,
      });
    } catch (error) {
      logger.warn(
        `Failed to initialize Engineering AI audit maintainer; failing closed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  const taskManagers = new CodexTaskManagerPool(registry, sessions, {
    logger,
    stateDir,
    appServerFactory: opts.appServerFactory,
    orchestrator: executionOrchestrator(opts.orchestrator),
    omnigent: opts.omnigent,
    bridgeWorkspaceId: bridgeRoot.id,
    fullAccess: opts.fullAccess,
    maxQueueSize: opts.maxQueueSize,
    onTaskLifecycleEvent: (event) => {
      auditMaintainer?.notifyEvent(event);
    },
    continuationAuthorize: (owner, workspaceId, scope) => {
      stateOwner?.assertCurrent();
      return registry.enabledIds().includes(workspaceId) && authStore.hasOwnerAuthorization(owner, workspaceId, scope);
    },
  });
  // Recover persisted non-terminal tasks for every workspace authorized by
  // this bridge before serving MCP. This makes crash/restart recovery
  // deterministic even when the first post-restart request is only a session
  // or execution summary and does not select a task manager explicitly.
  for (const workspaceId of authorizedWorkspaceIds) taskManagers.get(workspaceId);

  // After all authorized task managers are constructed/recovered, enqueue one
  // restart runtime event and start startup catchUp asynchronously; DO NOT
  // block bridge startup on Gemini generation. Catch-up errors log safely.
  if (auditMaintainer?.isEnabled) {
    const restartTimestamp = new Date().toISOString();
    auditMaintainer.notifyEvent({
      type: "restart",
      workspaceId: workspace.id,
      timestamp: restartTimestamp,
    });
    void auditMaintainer
      .catchUp()
      .catch((error) => {
        logger.warn(
          `Engineering AI audit maintenance startup catch-up failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
  }

  // The C2C-owned ZCode scheduled-queue coordinator starts with the bridge and
  // stops with it: it owns claims, dispatch through the native Desktop lane,
  // and the only terminal receipts the queue ever receives. It disables
  // itself (fail closed, logged) when no authorized queue root resolves.
  // Test-style bridges (persistRuntime: false) never auto-start it so tests
  // can never write worker-state into a real configured queue root.
  let zcodeCoordinator: ZcodeCoordinator | undefined;
  const wantCoordinator = opts.zcodeCoordinator ?? opts.persistRuntime !== false;
  if (wantCoordinator) {
    try {
      zcodeCoordinator = startZcodeCoordinatorFromEnvironment({
        registry,
        workspaceRoot: workspace.root,
        stateDir,
        logger,
      }) ?? undefined;
    } catch (error) {
      logger.warn(
        `ZCode coordinator failed to start; the scheduled queue stays ownerless: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  let publicBaseUrl: string | null = null;
  let publicProbe: PublicProbeResult | null = null;

  // Deterministic runtime identity: which source tree produced the code this
  // process is executing, and whether that code still matches the trees on
  // disk. Computed once at startup; surfaces drift instead of hiding it.
  let runtimeIdentity: RuntimeIdentity | null = null;
  try {
    runtimeIdentity = resolveRuntimeIdentity({ runtimeDir: currentRuntimeDir() });
  } catch (error) {
    logger.warn(
      `Runtime identity resolution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const releaseSummary = runtimeIdentity?.manifest
    ? {
        version: runtimeIdentity.manifest.version,
        sourceCommit: runtimeIdentity.manifest.sourceCommit,
        buildHash: runtimeIdentity.manifest.buildHash,
        releaseId: runtimeIdentity.releaseId,
        sourceParity: runtimeIdentity.sourceParity,
        buildParity: runtimeIdentity.buildParity,
      }
    : null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  // ---- Health (public but minimal) ---------------------------------------

  app.get("/health", (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceCount: authorizedWorkspaceIds.length,
      status: "ok",
      release: releaseSummary,
    });
  });

  // ---- OAuth + discovery ---------------------------------------------------

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      workspaceNames: registry.metadataFor(authorizedWorkspaceIds).map((entry) => entry.name),
      getBaseUrl,
      logger,
    })
  );

  // ---- MCP endpoint (bearer-protected) --------------------------------------

  const mcpHandler = createMcpHttpHandler(
    () => createMcpServer({
      workspace,
      logger,
      stateDir,
      registry,
      sessions,
      taskManagers,
      defaultWorkspaceId: workspace.id,
      authorizedWorkspaceIds,
      fullAccess: opts.fullAccess,
      oneDriveRoot: opts.oneDriveRoot,
    }),
    logger
  );
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    bearerAuth({
      store: authStore,
      workspaceId: workspace.id,
      authorizedWorkspaceIds,
      getBaseUrl,
      logger,
    }),
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  // ---- Admin API (loopback + admin token only; used by the CLI/Skill) --------

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    // Defense in depth: reject anything that arrived through a proxy/tunnel.
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end(); // do not advertise the admin surface
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.post("/admin/continuation", adminGuard, express.json({ limit: "128kb" }), async (req, res) => {
    try {
      stateOwner?.assertCurrent();
      const manifest = manifestSchema.parse(req.body?.manifest);
      if (!authorizedWorkspaceIds.includes(manifest.workspaceId) || !registry.enabledIds().includes(manifest.workspaceId) ||
          !authStore.hasOwnerAuthorization(manifest.ownerId, manifest.workspaceId, "execution.submit") ||
          !authStore.hasOwnerAuthorization(manifest.ownerId, manifest.workspaceId, "audit_mirror.write")) {
        res.status(403).json({ message: "Existing owner/workspace execution and audit grants required" }); return;
      }
      const manager = taskManagers.get(manifest.workspaceId);
      if (manager.getQueueState().activeTask) { res.status(409).json({ message: "Product writer active; keep durable fragment and retry at idle boundary" }); return; }
      const file = installApprovedManifest(stateDir, manifest);
      const controller = taskManagers.reloadContinuation(manifest.workspaceId);
      await controller.settled();
      res.json({ installed: true, file, supervision: controller.status(manifest.ownerId) });
    } catch { res.status(400).json({ message: "Continuation approval or local verification failed; inspect protected evidence" }); }
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      // Roots are local admin proof only; public MCP metadata stays path-free.
      authorizedWorkspaces: registry.metadataFor(authorizedWorkspaceIds).map(entry => ({
        ...entry, root: registry.get(entry.id).canonicalPath,
      })),
      port,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      publicProbe,
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      startedAt,
      stateDir,
      stateDomainGeneration: stateOwner?.generation,
      runtimeIdentity,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    tunnel
      .start(port)
      .then(async (url) => {
        const probe = await waitForPublicMcp(url, {
          fetchImpl: opts.publicFetch,
          timeoutMs: opts.publicProbeTimeoutMs,
          attemptTimeoutMs: opts.publicProbeAttemptTimeoutMs,
          intervalMs: opts.publicProbeIntervalMs,
        });
        publicProbe = probe;
        if (!probe.ok) {
          await tunnel.stop().catch(() => undefined);
          publicBaseUrl = null;
          persistRuntime();
          throw new Error(`Public MCP verification failed: ${probe.detail ?? "expected HTTP 401"}`);
        }
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url, publicProbe: probe });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      publicProbe = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info(`Revoked all tokens (${count})`);
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, express.json({ limit: "4kb" }), (req, res) => {
    const expected = req.body?.expectedRuntime;
    if (expected !== undefined && (!expected || expected.workspaceId !== workspace.id ||
        expected.pid !== process.pid || expected.port !== port || expected.startedAt !== startedAt ||
        expected.stateDomainGeneration !== stateOwner?.generation)) {
      res.status(409).json({ message: "Bridge generation changed; shutdown refused" });
      return;
    }
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const persistRuntime = (): void => {
    if (opts.persistRuntime === false) return;
    const state: RuntimeState = {
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      port,
      adminToken,
      adminTokenKnown: true,
      publicUrl: publicBaseUrl,
      startedAt,
      stateDir,
      stateDomainGeneration: stateOwner?.generation,
      release: releaseSummary ?? undefined,
    };
    writeRuntimeState(state, stateDir);
  };
  persistRuntime();

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      // Stop claiming new scheduled-queue work before anything else rejects
      // submissions; the coordinator finalizes its own heartbeat state.
      await zcodeCoordinator?.stop().catch((error) => {
        logger.warn(
          `ZCode coordinator stop failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
      // Close task managers first. This rejects new submissions immediately,
      // interrupts only the live writer, emits final terminal events, and
      // leaves durable queued records for the next bridge process to replay.
      await taskManagers.close();
      if (auditMaintainer) {
        await auditMaintainer.close().catch((error) => {
          logger.warn(
            `Engineering AI audit maintainer close failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
      }
      await tunnel.stop().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (opts.persistRuntime !== false) clearRuntimeState(workspace.id, {
        pid: process.pid, port, startedAt, stateDomainGeneration: stateOwner?.generation,
      }, stateDir);
      logger.info("Bridge stopped");
    } finally {
      // The listener and writable runtime have been closed before the state
      // generation is released. A replacement can therefore never overlap
      // this generation's auth/runtime writes.
      stateOwner?.release();
    }
  };

  return {
    workspace,
    registry,
    sessions,
    taskManagers,
    auditMaintainer,
    zcodeCoordinator,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}

function ensureOwnedAuthSnapshot(owner: StateDomainOwner, file: string): void {
  owner.assertCurrent();
  if (!fs.existsSync(file)) {
    owner.assertCurrent();
    writeSecureJson(file, { clients: [], tokens: [] });
    return;
  }
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !Array.isArray((value as { clients?: unknown }).clients) ||
        !Array.isArray((value as { tokens?: unknown }).tokens)) {
      throw new Error("invalid auth snapshot");
    }
  } catch {
    throw new Error("OAuth generation auth snapshot is invalid; refusing to start a writable bridge");
  }
  owner.assertCurrent();
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const enforceOwnership = opts.enforceStateOwnership ?? opts.persistRuntime !== false;
  const stateDir = resolveStateDir(opts.stateDir);
  if (!enforceOwnership) return startBridgeInternal({ ...opts, stateDir });

  const workspace = new Workspace(opts.workspaceRoot);
  const owner = acquireStateDomainOwner({
    stateDir,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    processInspector: opts.stateDomainProcessInspector,
  });


  try {
    return await startBridgeInternal({ ...opts, stateDir }, owner);
  } catch (error) {
    owner.release();
    throw error;
  }
}
