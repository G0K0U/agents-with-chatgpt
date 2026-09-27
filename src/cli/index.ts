import { installationRoot } from "../bridge/runtime-identity.js";
import { fullAccessDevelopmentEnabled } from "../config/development.js";
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { readAuthStatePointer } from "../bridge/state-owner.js";
import { reconcileStateDomains } from "../bridge/state-migration.js";
import { adminFetch, ensureBridge, stopBridge, findSharedBridgeObservation as findBridgeObservation,
  type SharedBridgeObservation } from "../process/daemon.js";
import { activateRelease, promoteCurrentBuild, releaseRepoRoot, releaseStatus, rollbackRelease, runReleaseGate } from "../process/release.js";
import { renderDeployReport, runLocalDeploy } from "../process/deploy.js";
import { diagnoseSharedTunnel } from "../process/shared-doctor.js";
import { requestRestart, waitRestartHandoff } from "../process/restart.js";
import { observeSupervisorStatus, stopSupervisorProcess } from "../supervisor/control.js";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import { probePublicMcp, type PublicProbeResult } from "../tunnel/probe.js";
import type { TunnelStatus } from "../tunnel/provider.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import { Logger } from "../logger/index.js";
import { getStateDir, initializeStateDir } from "../config/paths.js";
import { resolveZ2cRepoRoot } from "../config/z2c-repo.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import { mergeUiPrefs, readUiPrefs, SETUP_MODES, type SetupMode } from "../config/ui-prefs.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  clearChatPointer,
  mergeSession,
  readSession,
  resolveConversation,
  writeSession,
  PROTOCOL_STATES,
  WAITING_FOR,
  type ConversationMode,
  type ProtocolState,
  type WaitingFor,
} from "../session/state.js";
import { appendExecutionRecord } from "../execution/records.js";
import { saveExecutionOutput } from "../execution/output.js";
import {
  listOperatorVerificationProfiles,
  readOperatorVerificationProfile,
  registerOperatorVerificationProfile,
  removeOperatorVerificationProfile,
  resolveVerificationProfile,
} from "../execution/operator-verification.js";
import {
  cleanupVerificationRuntime,
  materializeVerificationProfile,
  prepareVerificationRuntime,
} from "../execution/verification.js";

const program = new Command();

program.command("continuation-install")
  .requiredOption("--manifest <file>", "Explicit locally approved manifest")
  .option("-w, --workspace <path>", "Existing bridge workspace")
  .option("--state-dir <path>", "Existing protected state domain")
  .option("--json")
  .action(async (opts) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const runtime = readRuntimeState(workspace.id, getStateDir(opts.stateDir));
    if (!runtime) throw new Error("Existing bridge runtime required");
    const stat = fs.lstatSync(opts.manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("Regular bounded approval file required");
    const manifest = JSON.parse(fs.readFileSync(opts.manifest, "utf8"));
    const result = await adminFetch(runtime, "POST", "/admin/continuation", 300_000, { manifest });
    say(JSON.stringify(result));
  });

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

/** Local harness output only. Never pasted into ChatGPT. */
const MAX_RECORD_OUTPUT_READ = 256 * 1024;

function readCappedUtf8(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
  stateDir?: string;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId, opts.stateDir);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  }, opts.stateDir);
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string, stateDir?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id, stateDir);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  publicProbe?: PublicProbeResult;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  publicUrl: string | null;
  tunnel: TunnelStatus;
  publicProbe: PublicProbeResult | null;
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
  stateDir?: string;
  stateDomainGeneration?: string;
}

/** Refresh only the observed external route; never request tunnel control. */
async function refreshExternalTunnelInfo(runtime: RuntimeState, info: AdminInfo): Promise<AdminInfo> {
  if (info.tunnel.management !== "external") return info;
  try {
    const refreshed = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info?observe=1", 15_000);
    if (refreshed.workspaceId === info.workspaceId && refreshed.pid === info.pid &&
        refreshed.port === info.port && refreshed.startedAt === info.startedAt &&
        refreshed.stateDomainGeneration === info.stateDomainGeneration &&
        refreshed.tunnel?.management === "external") return refreshed;
  } catch {
    // A failed read-only observation is unknown; never trigger a tunnel start.
  }
  return { ...info, tunnel: { ...info.tunnel, running: false, reachable: null,
    detail: "External tunnel observation refresh unavailable" } };
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean; stateDir?: string }
): Promise<{ runtime: RuntimeState; info: AdminInfo; workspace: Workspace; mcpUrl: string | null; publicProbe: PublicProbeResult | null }> {
  const stateDir = getStateDir(opts.stateDir);
  const workspace = new Workspace(workspaceRoot);
  const beforeStart = await findBridgeObservation(workspace.id, workspace.root, {
    stateDir,
    repairRuntime: false,
  });
  if (beforeStart.state === "stopped") {
    // This is a one-time import boundary. It runs only while no bridge is
    // serving, and never copies owner/pointer/slot/tunnel process metadata.
    reconcileStateDomains({ canonicalStateDir: stateDir });
  }
  const { runtime, observation } = await ensureBridge(workspaceRoot, { stateDir });
  let info = observation?.state === "healthy" && observation.adminInfo
    ? observation.adminInfo : await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  let publicProbe = info.publicProbe;
  if (opts.tunnel) {
    if (info.publicUrl) publicProbe = await probePublicMcp(info.publicUrl);
    if (!info.publicUrl || !publicProbe?.ok) {
      const ownerWorkspaceId = observation?.state === "healthy" && observation.shared ? runtime.workspaceId : workspace.id;
      const ownerTunnelState = readTunnelState(ownerWorkspaceId, stateDir);
      const namedReady = isNamedTunnelReady(ownerTunnelState);
      const requestedEndpoint = readLastEndpoint(workspace.id, stateDir);

      const candidateUrls: string[] = [];
      if (
        namedReady &&
        typeof ownerTunnelState.hostname === "string" &&
        ownerTunnelState.hostname.trim().length > 0
      ) {
        candidateUrls.push(`https://${ownerTunnelState.hostname.trim()}`);
      }
      if (
        requestedEndpoint &&
        requestedEndpoint.workspaceId === workspace.id &&
        typeof requestedEndpoint.publicUrl === "string" &&
        requestedEndpoint.publicUrl.trim().length > 0
      ) {
        const endpointUrl = requestedEndpoint.publicUrl.trim();
        if (!candidateUrls.includes(endpointUrl)) {
          candidateUrls.push(endpointUrl);
        }
      }

      let reusedCandidate = false;
      for (const candidate of candidateUrls) {
        let isHttps = false;
        try {
          const parsed = new URL(candidate);
          isHttps = parsed.protocol === "https:";
        } catch {
          isHttps = false;
        }
        if (!isHttps) continue;
        if (info.publicUrl && candidate === info.publicUrl && publicProbe && !publicProbe.ok) {
          continue;
        }
        const probe = await probePublicMcp(candidate);
        if (probe.ok) {
          info = {
            ...info,
            publicUrl: candidate,
            publicProbe: probe,
            tunnel: {
              ...info.tunnel,
              running: true,
              url: info.tunnel.url ?? candidate,
              provider: info.tunnel.provider ?? (namedReady ? "cloudflare-named" : null),
            },
          };
          publicProbe = probe;
          mcpUrl = `${candidate}/mcp`;
          reusedCandidate = true;
          break;
        } else if (!publicProbe) {
          publicProbe = probe;
        }
      }

      if (!reusedCandidate) {
        const binaries = detectTunnelBinaries();
        if (!binaries.cloudflared) {
          throw new Error(
            "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
          );
        }
        const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
        if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
        info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
        publicProbe = result.publicProbe ?? info.publicProbe ?? (await probePublicMcp(result.url));
      }
    }
    if (!info.publicUrl || !publicProbe?.ok) {
      throw new Error(`Public MCP verification failed: ${publicProbe?.detail ?? "expected HTTP 401"}`);
    }
    mcpUrl = `${info.publicUrl}/mcp`;
  }
  return { runtime, info, workspace, mcpUrl, publicProbe };
}

program
  .name("a2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Agents work (A2C; lanes: c2c/codex, z2c/zcode, g2c/gemini).`)
  .version(VERSION, "-v, --version")
  .option("--state-dir <path>", "explicit C2C state directory")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; stateDir?: string; port?: string }) => {
    const stateDir = getStateDir(opts.stateDir);
    const logger = new Logger({ name: "bridge", console: true, stateDir });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      stateDir,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
      fullAccess: fullAccessDevelopmentEnabled(),
    });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`bridge ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; stateDir?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const { runtime, info, workspace, mcpUrl, publicProbe } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel, stateDir: opts.stateDir });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
            stateDir: opts.stateDir,
          })
        : readLastEndpoint(workspace.id, opts.stateDir)?.connectorName;
      if (opts.json) {
        say(JSON.stringify({ ok: true, port: runtime.port, workspaceId: workspace.id, mcpUrl, connectorName, publicProbe }));
        return;
      }
      check(`当前项目已识别（${workspace.name}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; stateDir?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const { runtime, info, workspace, mcpUrl, publicProbe } = await ensureBridgeAndTunnel(root, { tunnel: opts.tunnel, stateDir: opts.stateDir });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
            stateDir: opts.stateDir,
          })
        : connectorNameFor({
            workspaceName: workspace.name,
            workspaceId: workspace.id,
            previousName: readLastEndpoint(workspace.id, opts.stateDir)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(workspace.id, opts.stateDir)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(runtime.workspaceId, opts.stateDir);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            publicProbe,
            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已识别（${workspace.name}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--state-dir <path>", "explicit C2C state directory")
  .action(async (opts: { workspace?: string; stateDir?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace), { stateDir: opts.stateDir });
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .action(async (opts: { workspace?: string; stateDir?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const handoff = await requestRestart(root, { tunnel: opts.tunnel, stateDir: opts.stateDir });
      say(`Restart handoff ${handoff.id} is active; replacement is owned by the detached helper.`);
      const result = await waitRestartHandoff(handoff.id, handoff.stateDir);
      check(`Bridge restarted (${result.workspaceId})`);
      if (result.tunnelReady) check("Secure public connection verified");
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .action(async (opts: { workspace?: string; json: boolean; stateDir?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const observation = await findBridgeObservation(workspace.id, workspace.root, { stateDir: opts.stateDir });
    const tunnelState = readTunnelState(
      observation.state === "healthy" ? observation.runtime.workspaceId : workspace.id,
      opts.stateDir
    );
    const namedReady = isNamedTunnelReady(tunnelState);
    const lastEndpoint = readLastEndpoint(workspace.id, opts.stateDir);
    const configuredPublicUrl = namedReady
      ? `https://${tunnelState.hostname}`
      : lastEndpoint?.publicUrl ?? null;
    if (observation.state === "unknown") {
      if (opts.json) {
        say(JSON.stringify({
          ok: false,
          running: null,
          state: "unknown",
          reason: observation.reason,
          workspaceId: workspace.id,
          workspaceRoot: workspace.root,
          public: configuredPublicUrl
            ? await probePublicMcp(configuredPublicUrl, 8_000)
            : null,
        }));
      } else {
        cross(`Bridge 状态无法确认（${observation.reason}），未将其视为未运行。`);
      }
      return;
    }
    if (observation.state === "stopped") {
      const publicProbe = configuredPublicUrl ? await probePublicMcp(configuredPublicUrl, 8_000) : null;
      const payload = {
        ok: false,
        running: false,
        state: "stopped",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceRoot: workspace.root,
        port: null,
        localHealth: { ok: false, status: null, detail: "bridge is not running" },
        mode: namedReady ? "named" : tunnelState.preference === "quick" ? "quick" : "local",
        publicHost: tunnelState.hostname ?? null,
        publicUrl: configuredPublicUrl,
        public: publicProbe,
        tunnel: {
          configured: namedReady || Boolean(lastEndpoint?.publicUrl),
          running: false,
          provider: namedReady ? "cloudflare-named" : tunnelState.provider ?? null,
          url: null,
        },
        auth: { tokenCount: null, pairingActive: false },
      };
      if (opts.json) say(JSON.stringify(payload));
      else {
        say("Bridge 未运行。使用 `c2c start` 启动。");
        if (publicProbe) say(`· 公网 MCP：${publicProbe.ok ? `可达（HTTP ${publicProbe.status}）` : `不可达（${publicProbe.detail}）`}`);
      }
      return;
    }
    const runtime = observation.runtime;
    let info: AdminInfo;
    try {
      info = observation.adminInfo ?? await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    } catch {
      // A reconciled pointer can prove process ownership without recovering
      // the process-local admin secret. Report the live bridge accurately and
      // leave destructive control to the validated restart path.
      const localHealth = await probeBridge(runtime.port);
      const publicProbe = configuredPublicUrl ? await probePublicMcp(configuredPublicUrl, 8_000) : null;
      const payload = {
        ok: false,
        running: localHealth !== null,
        state: localHealth ? "healthy" : "unknown",
        reason: "runtime_control_unavailable",
        workspaceId: workspace.id,
        workspaceRoot: workspace.root,
        port: runtime.port,
        pid: runtime.pid,
        localHealth: {
          ok: localHealth !== null,
          status: localHealth ? 200 : null,
          workspaceId: localHealth?.workspaceId ?? null,
        },
        mode: namedReady ? "named" : tunnelState.preference === "quick" ? "quick" : "local",
        publicHost: tunnelState.hostname ?? null,
        publicUrl: configuredPublicUrl,
        public: publicProbe,
        tunnel: {
          configured: namedReady || Boolean(lastEndpoint?.publicUrl),
          running: false,
          provider: namedReady ? "cloudflare-named" : tunnelState.provider ?? null,
          url: runtime.publicUrl,
        },
        auth: { tokenCount: null, pairingActive: null },
      };
      if (opts.json) say(JSON.stringify(payload));
      else {
        cross("Bridge 正在运行，但运行控制信息无法恢复；请执行一次受控重启。");
        if (localHealth) say(`· 本地健康检查：HTTP 200（端口 ${runtime.port}）`);
      }
      return;
    }
    info = await refreshExternalTunnelInfo(runtime, info);
    const localHealth = await probeBridge(runtime.port);
    const publicBaseUrl = observation.shared ? info.publicUrl : info.publicUrl ?? configuredPublicUrl;
    const publicProbe = publicBaseUrl ? await probePublicMcp(publicBaseUrl, 8_000) : null;
    const publicReady = !publicBaseUrl || Boolean(info.tunnel.running &&
      (info.tunnel.management !== "external" || info.tunnel.reachable === true) && publicProbe?.ok);
    const mode = info.tunnel.provider === "cloudflare-named" ? "named" : info.tunnel.provider === "cloudflare-quick" ? "quick" : "local";
    const payload = {
      ok: Boolean(localHealth && publicReady),
      running: true,
      state: "healthy",
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      shared: observation.shared,
      ownerWorkspace: { id: runtime.workspaceId, root: runtime.workspaceRoot },
      port: info.port,
      localHealth: { ok: localHealth !== null, status: localHealth ? 200 : null, workspaceId: localHealth?.workspaceId ?? null },
      mode,
      publicHost: tunnelState.hostname ?? (publicBaseUrl ? new URL(publicBaseUrl).hostname : null),
      publicUrl: publicBaseUrl,
      public: publicProbe,
      tunnel: info.tunnel,
      configuredTunnel: {
        preference: tunnelState.preference,
        namedReady,
        hostname: tunnelState.hostname ?? null,
        tunnelName: tunnelState.tunnelName ?? null,
        tunnelId: tunnelState.tunnelId ?? null,
      },
      auth: { tokenCount: info.tokenCount, pairingActive: info.pairingActive },
      pid: info.pid,
      startedAt: info.startedAt,
    };
    if (opts.json) {
      say(JSON.stringify(payload));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (publicProbe?.ok && publicBaseUrl) {
      const modeLabel = info.tunnel?.management === "external" ? " [外部服务/仅观测]" : "";
      check(`安全连接：${publicBaseUrl}/mcp（HTTP ${publicProbe.status}）${modeLabel}`);
    } else if (publicProbe) cross(`安全连接：不可达（${publicProbe.detail}）`);
    else say("· 安全连接：未启用（本地模式）");
    if (info.tunnel?.management === "external") {
      say("· 隧道控制：外部独立服务（无进程所有权，ownsProcess=false）");
    }
    check(`本地健康检查：${localHealth ? "HTTP 200" : "失败"}`);
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean; stateDir?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 22, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir(opts.stateDir));
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    let sharedObservation: Extract<SharedBridgeObservation, { state: "healthy" }> | null = null;
    let bridgeUnknown = false;
    if (workspace) {
      const observation = await findBridgeObservation(workspace.id, workspace.root, { stateDir: opts.stateDir });
      if (observation.state === "healthy") {
        runtime = observation.runtime;
        if (observation.shared) sharedObservation = observation;
      } else if (observation.state === "unknown") {
        bridgeUnknown = true;
        report.bridge = { ok: false, detail: `状态无法确认（${observation.reason}），未自动修复` };
      } else if (opts.fix) {
        try {
          const ensured = await ensureBridge(root, { stateDir: opts.stateDir });
          runtime = ensured.runtime;
          if (ensured.observation?.state === "healthy" && ensured.observation.shared) sharedObservation = ensured.observation;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id, opts.stateDir) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const tunnelState = workspace ? readTunnelState(workspace.id, opts.stateDir) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (sharedObservation && runtime && workspace) {
      // Doctor on B diagnoses the authenticated owner A. Repairs that restart
      // the shared bridge require the explicit shared stop/restart lifecycle.
      const ownerInfo = sharedObservation.adminInfo
        ? await refreshExternalTunnelInfo(runtime, sharedObservation.adminInfo)
        : null;
      const diagnosis = await diagnoseSharedTunnel(ownerInfo
        ? { ...sharedObservation, adminInfo: ownerInfo }
        : sharedObservation);
      report.tunnel = diagnosis.report;
      if (diagnosis.report.ok && diagnosis.publicUrl) {
        const nextMcp = mcpUrlFromPublic(diagnosis.publicUrl)!;
        const boundName = persistWorkspaceEndpoint({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          port: runtime.port,
          publicUrl: diagnosis.publicUrl,
          mcpUrl: nextMcp,
          previous: lastEndpoint,
          stateDir: opts.stateDir,
        });
        chatgptRepair = { ...chatgptRepair, mcpUrl: nextMcp, connectorName: boundName,
          connectorAction: connectorAction(lastEndpoint?.mcpUrl, nextMcp) };
      } else if (diagnosis.report.detail === "NAMED_TUNNEL_DOWN") {
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      }
    } else if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      info = await refreshExternalTunnelInfo(runtime, info);
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root, { stateDir: opts.stateDir });
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root, { stateDir: opts.stateDir })).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: workspace!.id,
              workspaceName: workspace!.name,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
              stateDir: opts.stateDir,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`已生成新的配对码，需要更新「${boundName}」`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (bridgeUnknown) {
      report.tunnel = report.tunnel ?? { ok: false, detail: "Bridge 状态无法确认，未执行连接器修复" };
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      // One operational truth source: unified machine-readable view.
      let unified: unknown = null;
      try {
        const { buildUnifiedReport } = await import("../process/unified-report.js");
        unified = await buildUnifiedReport({
          repoRoot: installationRoot(),
          stateDir: getStateDir(opts.stateDir),
          workspaceId: workspace?.id ?? "",
          workspaceRoot: root,
          runtime,
        });
      } catch (error) {
        unified = { error: error instanceof Error ? error.message : String(error) };
      }
      // R1.1: surface provider bootstrap states in the flat doctor report too.
      const p = (unified as { providers?: { state?: string; data?: unknown } } | null)?.providers;
      if (p?.data) {
        const d = p.data as { codex?: { state?: string }; gemini?: { state?: string }; zcode?: { state?: string; registrationLive?: boolean; workspaceBinding?: string; attested?: boolean | null } };
        report.providers = {
          ok: p.state === "READY",
          detail: `codex=${d.codex?.state} gemini=${d.gemini?.state} zcode=${d.zcode?.state} (registration=${String(d.zcode?.registrationLive)} binding=${d.zcode?.workspaceBinding} attested=${String(d.zcode?.attested)})`,
        };
      }
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair, unified }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
      providers: "Providers",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，还需要在 ChatGPT 删除并重新添加该连接。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- deploy (one-command local deployment)

program
  .command("deploy")
  .description("One-command local deployment from a clone: checks, local bridge, health, tunnel gate (public tunnel setup stays a human step)")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--no-start-bridge", "report checks and the tunnel gate only; do not start the local bridge")
  .option("--autostart", "opt in to registering the logon autostart task (Windows)", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; stateDir?: string; startBridge: boolean; autostart: boolean; json: boolean }) => {
    try {
      const report = await runLocalDeploy({
        workspaceRoot: resolveWorkspace(opts.workspace),
        stateDir: opts.stateDir,
        startBridge: opts.startBridge,
        autostart: opts.autostart,
      });
      if (opts.json) {
        say(JSON.stringify(report));
      } else {
        for (const line of renderDeployReport(report)) say(line);
      }
      if (!report.ok) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const runtime = await findLiveBridge(workspace.id, workspace.root);
    if (runtime) {
      await adminFetch(runtime, "POST", "/admin/revoke-all");
    } else {
      // bridge not running: revoke directly in the persisted store
      const pointer = readAuthStatePointer();
      new AuthStore(workspace.id, pointer ? { file: pointer.authFile } : {}).revokeAll();
    }
    check("已断开 ChatGPT 对当前项目的访问（所有令牌已吊销）");
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = installationRoot();

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

program
  .command("update-check")
  .description("Check GitHub for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- release (deterministic runtime identity)

const release = program
  .command("release")
  .description("Build, verify, and activate immutable release artifacts (last-known-good)");

release
  .command("build")
  .description("Typecheck, build, write the build manifest, and promote an immutable release copy")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const root = releaseRepoRoot();
    const gate = runReleaseGate(root, { quick: true });
    const promoted = gate.ok ? promoteCurrentBuild(root) : { ok: false, releaseId: null, manifest: null, error: "gate failed" };
    const payload = { ok: promoted.ok, gate, releaseId: promoted.releaseId, error: promoted.error };
    if (opts.json) say(JSON.stringify(payload));
    else {
      for (const step of gate.steps) say(`${step.ok ? "✓" : "✗"} ${step.name} (${step.durationMs}ms)${step.ok ? "" : `\n  ${step.detail ?? ""}`}`);
      say(promoted.ok ? `Release promoted: ${promoted.releaseId}` : `Release build failed: ${promoted.error}`);
    }
    if (!payload.ok) process.exitCode = 1;
  });

release
  .command("activate")
  .description("Run the full release gate and atomically repoint the last-known-good release")
  .option("--quick", "run focused regression suites instead of the full suite", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { quick: boolean; json: boolean }) => {
    const root = releaseRepoRoot();
    const result = activateRelease(root, { quick: opts.quick });
    if (opts.json) say(JSON.stringify({ ok: result.ok, gate: result.gate, pointer: result.pointer, error: result.error }));
    else {
      for (const step of result.gate.steps) say(`${step.ok ? "✓" : "✗"} ${step.name} (${step.durationMs}ms)${step.ok ? "" : `\n  ${step.detail ?? ""}`}`);
      say(result.ok ? `Last-known-good release activated: ${result.pointer?.releaseId}` : `Activation failed: ${result.error}`);
    }
    if (!result.ok) process.exitCode = 1;
  });

release
  .command("rollback")
  .description("Repoint the last-known-good release to the previously activated release (validated; bounded A/B swap)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const root = releaseRepoRoot();
    const result = rollbackRelease(root);
    if (opts.json) say(JSON.stringify(result));
    else {
      const msg = result.ok
        ? `Rolled back to ${result.pointer?.releaseId}${result.error ? ` (${result.error})` : ""}`
        : `Rollback failed: ${result.error}`;
      say(msg);
    }
    if (!result.ok) process.exitCode = 1;
  });

release
  .command("status", { isDefault: true })
  .description("Show release identity, source/build parity, and drift")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const root = releaseRepoRoot();
    const status = releaseStatus(root);
    if (opts.json) say(JSON.stringify({ ok: status.drift.every(d => d === "NONE" || d === "LKG_AHEAD_OF_DIST"), ...status }));
    else {
      say(`dist release: ${status.distReleaseId ?? "none (no build manifest)"}`);
      say(`source parity: ${status.distSourceParity}  build parity: ${status.distBuildParity}`);
      say(`last-known-good: ${status.pointer?.releaseId ?? "none"}`);
      say(`drift: ${status.drift.join(", ") || "NONE"}`);
    }
    if (status.drift.some(d => d !== "NONE" && d !== "LKG_AHEAD_OF_DIST")) process.exitCode = 1;
  });

// ---------------------------------------------------------------- plane (local shared session/activity index)

// Safe local dashboard/index for the provider-neutral shared session plane.
// Read-only, loopback-free (pure CLI over the durable projection + live Z2C
// observation), local-operator principal only. Native Codex/ZCode UIs have no
// supported mechanism to ingest external (A2C-originated) session records, so
// this command is the local inspection surface for A2C work.
program
  .command("plane")
  .description("Shared agent session/activity plane (read-only local index)")
  .option("--state-dir <path>", "explicit C2C state directory");

async function planeForCli(stateDirOpt?: string) {
  const { AgentPlane } = await import("../session-plane/plane.js");
  const { loadZcodeSessionOwnership } = await import("../execution/zcode-session-ownership.js");
  const { ZcodeSessionClient, loadZcodeSessionConfig } = await import("../execution/zcode-session-client.js");
  const { WorkspaceRegistry } = await import("../workspace/registry.js");
  const stateDir = getStateDir(stateDirOpt);
  const registry = new WorkspaceRegistry({ stateDir });
  const workspaces = registry.enabledIds().flatMap((id) => {
    try {
      const w = registry.getWorkspace(id);
      return [{ workspaceId: w.id, canonicalPath: w.root }];
    } catch {
      return [];
    }
  });
  let zcodeClient: InstanceType<typeof ZcodeSessionClient> | null = null;
  try {
    zcodeClient = new ZcodeSessionClient(loadZcodeSessionConfig());
  } catch {
    zcodeClient = null; // Z2C lane unconfigured: codex/gemini projection still served
  }
  return new AgentPlane({
    stateDir,
    workspaces: () => workspaces,
    zcodeClient,
    ownership: loadZcodeSessionOwnership(stateDir),
  });
}

planeCommandScaffold();

function planeCommandScaffold(): void {
  const plane = program.commands.find((c) => c.name() === "plane");
  if (!plane) return;

  plane
    .command("sessions")
    .description("List the shared session projection across Codex, Gemini/Antigravity, and ZCode (observe-only)")
    .option("-p, --provider <name>", "filter: codex | gemini | zcode")
    .option("-o, --origin <name>", "filter: a2c | native | desktop")
    .option("-w, --workspace-id <id>", "filter by A2C workspace id")
    .option("-n, --limit <n>", "page size (1-100)", "50")
    .option("--json", "machine-readable output", false)
    .option("--state-dir <path>", "explicit C2C state directory")
    .action(async (opts: { provider?: string; origin?: string; workspaceId?: string; limit?: string; json?: boolean; stateDir?: string }) => {
      const planeApi = await planeForCli(opts.stateDir);
      const result = await planeApi.listSessions(undefined, {
        provider: opts.provider as never,
        origin: opts.origin as never,
        workspaceId: opts.workspaceId,
        limit: Number(opts.limit ?? 50),
      });
      if (opts.json) {
        say(JSON.stringify(result));
        return;
      }
      say(`shared sessions (${result.sessions.length}${result.nextCursor ? "+, more pages" : ""}):`);
      for (const s of result.sessions) {
        say(`  [${s.provider}/${s.origin}] ${s.sessionId}  status=${s.status}  model=${s.model ?? "?"}  ws=${s.workspaceId}  tasks=${s.taskIds.length}`);
      }
    });

  plane
    .command("messages")
    .description("Visible user/assistant message history of one shared session (redacted, bounded; observe-only)")
    .argument("<sessionId>", "shared-plane session id")
    .option("-n, --limit <n>", "max messages (1-50)", "20")
    .option("--json", "machine-readable output", false)
    .option("--state-dir <path>", "explicit C2C state directory")
    .action(async (sessionId: string, opts: { limit?: string; json?: boolean; stateDir?: string }) => {
      const planeApi = await planeForCli(opts.stateDir);
      const result = await planeApi.sessionMessages(undefined, sessionId, Number(opts.limit ?? 20));
      if (opts.json) {
        say(JSON.stringify(result));
        return;
      }
      say(`${result.provider}/${result.origin} ${result.sessionId}:`);
      for (const m of result.messages) {
        say(`  ${m.role === "user" ? ">" : "<"}${m.restricted ? " [restricted]" : ""} ${m.text.slice(0, 200).replace(/\s+/g, " ")}`);
      }
    });

  plane
    .command("activity")
    .description("Bounded cross-provider activity feed with seq cursor (observe-only)")
    .option("-p, --provider <name>", "filter: codex | gemini | zcode")
    .option("-s, --session-id <id>", "filter by session id")
    .option("-w, --workspace-id <id>", "filter by A2C workspace id")
    .option("--after-seq <n>", "events after this sequence number")
    .option("-n, --limit <n>", "page size (1-100)", "50")
    .option("--json", "machine-readable output", false)
    .option("--state-dir <path>", "explicit C2C state directory")
    .action(async (opts: { provider?: string; sessionId?: string; workspaceId?: string; afterSeq?: string; limit?: string; json?: boolean; stateDir?: string }) => {
      const planeApi = await planeForCli(opts.stateDir);
      const result = await planeApi.listActivity(undefined, {
        provider: opts.provider as never,
        sessionId: opts.sessionId,
        workspaceId: opts.workspaceId,
        afterSeq: opts.afterSeq !== undefined ? Number(opts.afterSeq) : undefined,
        limit: Number(opts.limit ?? 50),
      });
      if (opts.json) {
        say(JSON.stringify(result));
        return;
      }
      say(`activity (lastSeq=${result.lastSeq}):`);
      for (const e of result.events) {
        say(`  #${e.seq} [${e.provider}] ${e.type} session=${e.sessionId ?? "-"} task=${e.taskId ?? "-"} — ${e.summary}`);
      }
    });

  plane
    .command("task")
    .description("Bounded task view incl. changed files, actionEvidence, verification (observe-only)")
    .argument("<workspaceId>", "A2C workspace id")
    .argument("<taskId>", "C2C task id (c2c_…)")
    .option("--json", "machine-readable output", false)
    .option("--state-dir <path>", "explicit C2C state directory")
    .action(async (workspaceId: string, taskId: string, opts: { json?: boolean; stateDir?: string }) => {
      const planeApi = await planeForCli(opts.stateDir);
      const view = planeApi.readTask(undefined, workspaceId, taskId);
      say(JSON.stringify(opts.json ? view : view, null, opts.json ? 0 : 2));
    });

  plane
    .command("output")
    .description("Read one sanitized captured output body by workspace-scoped id (observe-only)")
    .argument("<workspaceId>", "A2C workspace id")
    .argument("<outputId>", "numeric output id")
    .option("--json", "machine-readable output", false)
    .option("--state-dir <path>", "explicit C2C state directory")
    .action(async (workspaceId: string, outputId: string, opts: { json?: boolean; stateDir?: string }) => {
      const planeApi = await planeForCli(opts.stateDir);
      const view = planeApi.readOutput(undefined, workspaceId, Number(outputId));
      say(JSON.stringify(view, null, opts.json ? 0 : 2));
    });
}

// ---------------------------------------------------------------- supervisor (bounded self-healing)

const supervisorCmd = program
  .command("supervisor")
  .description("Bounded control-plane supervisor: observe and perform targeted recovery");

supervisorCmd
  .command("start")
  .description("Start the supervisor as a detached background process")
  .option("--workspace <dir>", "supervised control-plane workspace root", process.cwd())
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace: string; stateDir?: string; json: boolean }) => {
    const stateDir = getStateDir(opts.stateDir);
    const workspaceRoot = fs.realpathSync.native(path.resolve(opts.workspace));
    const before = observeSupervisorStatus(stateDir, workspaceRoot);
    if (before.state === "running" || before.state === "stale") {
      say(opts.json ? JSON.stringify({ ok: before.ok, state: before.state, pid: before.pid }) : `Supervisor already running (pid ${before.pid}, ${before.state}).`);
      if (!before.ok) process.exitCode = 1;
      return;
    }
    const previousGenerationEnded = before.state === "stopped" &&
      (before.processStatus === "dead" ||
        (before.processStatus === "reused" && before.processReason === "start_identity_mismatch"));
    if (before.state === "unknown" || (before.state === "stopped" && !previousGenerationEnded)) {
      say(opts.json ? JSON.stringify({ ok: false, state: before.state, reason: before.detail }) : `Supervisor ownership uncertain: ${before.detail}`);
      process.exitCode = 1;
      return;
    }
    // Spawn THIS same CLI entry (dist or tsx dev) detached for the run loop.
    const entry = path.join(installationRoot(), "bin", "c2c.js");
    const entryArgs = entry.endsWith(".ts") ? ["--import", "tsx/esm", entry] : [entry];
    const runArgs = [...entryArgs, "supervisor", "run", "--workspace", workspaceRoot, "--state-dir", stateDir];
    const child = spawn(process.execPath, runArgs, {
      cwd: workspaceRoot,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.unref();
    // Wait briefly for the first heartbeat so failures surface now.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const observation = observeSupervisorStatus(stateDir, workspaceRoot);
      if (observation.pid === child.pid && observation.state === "running") {
        say(opts.json ? JSON.stringify({ ok: observation.ok, pid: child.pid, overall: observation.overall }) : `Supervisor running (pid ${child.pid}, ${observation.overall}).`);
        if (!observation.ok) process.exitCode = 1;
        return;
      }
    }
    say(opts.json ? JSON.stringify({ ok: false, pid: child.pid, reason: "no_verified_heartbeat" }) : `Supervisor spawned (pid ${child.pid}) but no verified heartbeat appeared.`);
    process.exitCode = 1;
  });

supervisorCmd
  .command("run", { hidden: true })
  .description("Supervisor loop entry (used by the detached start command)")
  .requiredOption("--workspace <dir>", "supervised control-plane workspace root")
  // Commander assigns --state-dir to the root command when both levels
  // declare it. Validate the explicitly supplied root value in the action.
  .option("--state-dir <path>", "explicit C2C state directory")
  .action(async (opts: { workspace: string; stateDir?: string }) => {
    const { Supervisor } = await import("../supervisor/supervisor.js");
    const suppliedStateDir = opts.stateDir ?? (program.opts() as { stateDir?: string }).stateDir;
    if (!suppliedStateDir) throw new Error("supervisor run requires explicit --state-dir");
    const stateDir = getStateDir(suppliedStateDir);
    const supervisor = new Supervisor({
      repoRoot: installationRoot(),
      stateDir,
      workspaceRoot: path.resolve(opts.workspace),
    });
    if (!await supervisor.acquireLock()) {
      say("Another live supervisor holds the lock; exiting.");
      return;
    }
    // R1.1 takeover bootstrap: reconcile provider desired state (on-demand
    // readiness + managed ZCode Desktop) once, bounded and idempotent, before
    // the observation loop takes over continuous reconciliation.
    const bootstrapTask = supervisor.bootstrapOnTakeover().catch((error) => {
      say(`Provider bootstrap failed (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    });
    const shutdown = (): void => { supervisor.stop(); };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    try {
      await supervisor.run();
      await bootstrapTask;
      await supervisor.waitForRecoveries();
    } finally {
      supervisor.releaseLock();
    }
  });

supervisorCmd
  .command("stop")
  .description("Stop a running supervisor")
  .option("--workspace <dir>", "supervised control-plane workspace root", process.cwd())
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace: string; stateDir?: string; json: boolean }) => {
    const result = await stopSupervisorProcess(getStateDir(opts.stateDir), path.resolve(opts.workspace));
    say(opts.json ? JSON.stringify(result) : result.stopped ? `Supervisor stopped (pid ${result.pid}).` : `Supervisor stop refused: ${result.reason ?? "unknown"}`);
    if (!result.ok) process.exitCode = 1;
  });

supervisorCmd
  .command("status", { isDefault: true })
  .description("Show the supervisor snapshot")
  .option("--workspace <dir>", "supervised control-plane workspace root", process.cwd())
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace: string; stateDir?: string; json: boolean }) => {
    const observed = observeSupervisorStatus(getStateDir(opts.stateDir), path.resolve(opts.workspace));
    const report = {
      ok: observed.ok, state: observed.state, running: observed.running, pid: observed.pid,
      processStatus: observed.processStatus, overall: observed.overall,
      heartbeatAgeMs: observed.heartbeatAgeMs, heartbeatStale: observed.heartbeatStale,
      tick: observed.snapshot?.tick ?? null, lastTickAt: observed.snapshot?.lastTickAt ?? null,
      components: observed.state === "running" || observed.state === "stale" ? observed.snapshot?.components ?? [] : [],
      detail: observed.detail ?? null,
    };
    if (opts.json) say(JSON.stringify(report));
    else {
      say(`supervisor: ${report.state}  overall: ${report.overall}  pid: ${report.pid ?? "none"}`);
      if (report.detail) say(report.detail);
      for (const component of report.components) say(`  ${component.component.padEnd(18)} ${component.state.padEnd(10)} ${component.detail ?? ""}`);
    }
    if (!observed.ok) process.exitCode = 1;
  });

supervisorCmd
  .command("reconcile")
  .description("Observe legacy ZCode Desktop registration without changing Desktop state")
  .option("--workspace <dir>", "supervised control-plane workspace root", process.cwd())
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace: string; stateDir?: string; json: boolean }) => {
    const { ZcodeDesktopReconciler } = await import("../supervisor/provider-bootstrap.js");
    const stateDir = getStateDir(opts.stateDir);
    const reconciler = new ZcodeDesktopReconciler({
      workspaceRoot: path.resolve(opts.workspace),
      stateDir,
      z2cRepoRoot: resolveZ2cRepoRoot(installationRoot()),
    });
    const obs = reconciler.observe();
    const action = "none (observation only)";
    const after = reconciler.observe();
    if (opts.json) {
      say(JSON.stringify({ ok: true, before: { state: obs.state, detail: obs.detail }, action, after: { state: after.state, detail: after.detail, managed: after.managed, desktopPid: after.desktopPid, registrationLive: after.registrationLive } }));
    } else {
      say(`before: ${obs.state}${obs.detail ? ` (${obs.detail})` : ""}`);
      say(`action: ${action}`);
      say(`after:  ${after.state}${after.detail ? ` (${after.detail})` : ""}`);
    }
    if (after.state !== "READY" && after.state !== "RECOVERING") process.exitCode = 1;
  });

// ---------------------------------------------------------------- verification (trusted operator profiles)

// F01: run_tests=true only executes a test command the LOCAL OPERATOR
// registered (or a bridge-owned built-in). These commands manage that trust
// registry; task input can never define or alter a verification command.
const verificationCmd = program
  .command("verification")
  .description("Manage trusted local verification profiles (run_tests) for workspaces");

interface VerificationRegisterOptions {
  workspace?: string;
  stateDir?: string;
  id?: string;
  executable: string;
  arg: readonly string[];
  cwd: string;
  timeoutMs: string;
  sandbox: string;
  summaryKind: string;
  force?: boolean;
  json: boolean;
}

function registerOrUpdate(input: VerificationRegisterOptions, mode: "register" | "update"): void {
  const workspace = new Workspace(resolveWorkspace(input.workspace));
  const cwd = input.cwd.trim().toLowerCase();
  if (cwd !== "workspace" && cwd !== "verification") throw new Error("--cwd must be workspace or verification");
  const sandbox = input.sandbox.trim().toLowerCase();
  if (sandbox !== "readonly" && sandbox !== "workspacewrite") throw new Error("--sandbox must be readonly or workspaceWrite");
  const summaryKind = input.summaryKind.trim().toLowerCase();
  if (summaryKind !== "pytest" && summaryKind !== "generic") throw new Error("--summary-kind must be pytest or generic");
  const timeoutMs = parseInt(input.timeoutMs, 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
    throw new Error("--timeout-ms must be an integer between 1000 and 1800000");
  }
  const argv = [...input.arg];
  if (argv.length === 0) throw new Error("at least one --arg is required (the verifier argv vector)");
  const existing = (() => {
    try { return readOperatorVerificationProfile(workspace.id, input.stateDir); }
    catch { return null; }
  })();
  if (mode === "register" && existing && !input.force) {
    throw new Error(`a verification profile already exists for this workspace (id ${existing.id}); use 'verification update' or --force`);
  }
  if (mode === "update" && !existing) {
    throw new Error("no existing profile to update; use 'verification register'");
  }
  const record = registerOperatorVerificationProfile({
    workspaceRoot: workspace.root,
    id: input.id?.trim() || existing?.id || "operator",
    executable: input.executable,
    argv,
    cwd,
    timeoutMs,
    sandbox: sandbox === "readonly" ? "readOnly" : "workspaceWrite",
    summaryKind,
  }, input.stateDir);
  say(JSON.stringify({ ok: true, action: mode, record }));
}

verificationCmd
  .command("list")
  .description("List registered verification profiles (validity-checked, never executed)")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: { stateDir?: string; json: boolean }) => {
    const entries = listOperatorVerificationProfiles(opts.stateDir);
    const payload = entries.map(({ record, error }) => record
      ? { workspaceId: record.workspaceId, workspaceRoot: record.workspaceRoot, id: record.id, executable: record.executable, argv: record.argv, cwd: record.cwd, timeoutMs: record.timeoutMs, sandbox: record.sandbox, summaryKind: record.summaryKind, valid: true }
      : { valid: false, error });
    say(opts.json ? JSON.stringify({ ok: true, profiles: payload }) : (payload.length === 0
      ? "No operator verification profiles registered."
      : payload.map((p) => p.valid
        ? `${p.workspaceId}  ${p.id}  ${p.executable}  (${p.sandbox}, ${p.timeoutMs}ms)\n    workspace: ${p.workspaceRoot}`
        : `INVALID ${p.error}`).join("\n")));
  });

verificationCmd
  .command("inspect")
  .description("Show the profile that run_tests=true would use for a workspace")
  .option("-w, --workspace <path>")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; stateDir?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const profile = resolveVerificationProfile(workspace, opts.stateDir);
    const operatorId = (() => {
      try { return readOperatorVerificationProfile(workspace.id, opts.stateDir).id; }
      catch { return null; }
    })();
    const source = profile === null ? "none" : (operatorId !== null && profile.id === operatorId ? "operator" : "builtin");
    const payload = {
      ok: profile !== null,
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      source,
      profile,
    };
    say(opts.json ? JSON.stringify(payload) : (profile
      ? `source: ${source}\nprofile: ${profile.id}\nexecutable: ${profile.executable}\nargv: ${profile.argv.join(" ")}\ncwd: ${profile.cwd}  timeout: ${profile.timeoutMs}ms  sandbox: ${profile.sandbox}  network: false`
      : `No verification profile resolves for workspace ${workspace.name} (${workspace.id}). run_tests=true tasks fail with NO_VERIFICATION_PROFILE. Register one with 'c2c verification register'.`));
  });

  verificationCmd
  .command("register")
  .description("Register the trusted verification profile for a workspace (operator trust decision)")
  .option("-w, --workspace <path>")
  .requiredOption("--executable <path-or-basename>", "real executable (absolute path or PATH basename; shell scripts rejected)")
  .requiredOption("--arg <value>", "argv element; repeat for every argument", (value: string, previous: string[]) => [...(previous ?? []), value], [] as string[])
  .option("--id <id>", "profile id", "operator")
  .option("--cwd <choice>", "workspace or verification", "workspace")
  .option("--timeout-ms <n>", "bounded runtime in milliseconds", "300000")
  .option("--sandbox <choice>", "readOnly or workspaceWrite", "workspaceWrite")
  .option("--summary-kind <choice>", "pytest or generic", "generic")
  .option("--force", "replace an existing registration", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: VerificationRegisterOptions) => {
    try { registerOrUpdate(opts, "register"); }
    catch (error) { handleCliError(error, opts.json); }
  });

verificationCmd
  .command("update")
  .description("Replace the registered verification profile for a workspace")
  .option("-w, --workspace <path>")
  .requiredOption("--executable <path-or-basename>")
  .requiredOption("--arg <value>", "argv element; repeat for every argument", (value: string, previous: string[]) => [...(previous ?? []), value], [] as string[])
  .option("--id <id>", "profile id")
  .option("--cwd <choice>", "workspace or verification", "workspace")
  .option("--timeout-ms <n>", "bounded runtime in milliseconds", "300000")
  .option("--sandbox <choice>", "readOnly or workspaceWrite", "workspaceWrite")
  .option("--summary-kind <choice>", "pytest or generic", "generic")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: VerificationRegisterOptions) => {
    try { registerOrUpdate(opts, "update"); }
    catch (error) { handleCliError(error, opts.json); }
  });

verificationCmd
  .command("remove")
  .description("Remove the registered verification profile for a workspace")
  .option("-w, --workspace <path>")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; stateDir?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const removed = removeOperatorVerificationProfile(workspace.id, opts.stateDir);
      say(opts.json ? JSON.stringify({ ok: removed }) : (removed ? "Verification profile removed." : "No profile was registered for this workspace."));
      if (!removed) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

verificationCmd
  .command("preflight")
  .description("Dry-run: resolve and materialize the verification profile WITHOUT executing anything")
  .option("-w, --workspace <path>")
  .option("--state-dir <path>", "explicit C2C state directory")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; stateDir?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const stateDir = getStateDir(opts.stateDir);
      const profile = resolveVerificationProfile(workspace, opts.stateDir);
      if (!profile) {
        const payload = { ok: false, reason: "NO_VERIFICATION_PROFILE", workspaceId: workspace.id };
        say(opts.json ? JSON.stringify(payload) : "No verification profile resolves; run_tests=true tasks will fail closed.");
        process.exitCode = 1;
        return;
      }
      const runtimeRoot = path.join(stateDir, "verification-preflight");
      fs.mkdirSync(runtimeRoot, { recursive: true });
      const taskId = `c2c_${randomBytes(6).toString("hex")}`;
      const runtime = prepareVerificationRuntime(runtimeRoot, taskId);
      try {
        const materialized = materializeVerificationProfile(profile, workspace, runtime);
        const payload = {
          ok: true,
          profileId: materialized.profileId,
          workspaceId: materialized.workspaceId,
          executable: materialized.executable,
          argv: materialized.argv,
          cwd: materialized.cwd,
          cwdAlias: materialized.cwdAlias,
          timeoutMs: materialized.timeoutMs,
          network: materialized.network,
          sandbox: materialized.sandboxPolicy,
          commandLabel: materialized.commandLabel,
          argvHash: materialized.argvHash,
        };
        say(opts.json ? JSON.stringify(payload) : [
          `preflight OK — run_tests=true would execute:`,
          `  ${materialized.commandLabel}`,
          `  executable : ${materialized.executable}`,
          `  cwd        : ${materialized.cwdAlias} (${materialized.cwd})`,
          `  timeout    : ${materialized.timeoutMs}ms   network: false   sandbox: ${materialized.sandbox}`,
          `  argvHash   : ${materialized.argvHash.slice(0, 16)}…`,
        ].join("\n"));
      } finally {
        cleanupVerificationRuntime(runtimeRoot, runtime);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- session (ChatGPT conversation / Project memory)

const session = program
  .command("session")
  .description("Remember the ChatGPT Project and conversation for this workspace");

session
  .command("get", { isDefault: true })
  .description("Show the saved ChatGPT conversation / Project for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const saved = readSession(workspace.id);
    const conversation = resolveConversation(saved);
    if (opts.json) say(JSON.stringify({ ok: true, session: saved, conversation }));
    else if (!saved) {
      say("尚未记录 ChatGPT 会话。新仓库默认使用 Project 合集。");
    } else {
      say(`模式：${conversation.mode === "project" ? "Project 合集" : "长对话"}`);
      if (conversation.projectUrl) say(`合集：${conversation.projectUrl}`);
      if (saved.title) say(`会话：${saved.title}`);
      if (saved.url) say(`对话：${saved.url}`);
      if (saved.connectorName) say(`连接器：${saved.connectorName}`);
      if (saved.taskId) say(`任务：${saved.taskId}（第 ${saved.iteration ?? 0} 轮，${saved.lastState ?? "?"}）`);
      if (saved.checkpoint) {
        say(
          `存档：${saved.checkpoint.protocolState} / 等待 ${saved.checkpoint.waitingFor}（第 ${saved.checkpoint.iteration} 轮）`
        );
      }
    }
  });

session
  .command("set")
  .description("Save the ChatGPT Project and/or conversation for this workspace")
  .option("-w, --workspace <path>")
  .option("--url <url>", "ChatGPT conversation URL from the address bar")
  .option("--title <title>")
  .option("--task <id>")
  .option("--iteration <n>")
  .option("--state <state>", "last protocol state, e.g. EXECUTED")
  .option("--mode <mode>", "long-chat or project")
  .option("--project-url <url>", "ChatGPT Project collection URL (…/g/g-p-…/project)")
  .option("--connector-name <name>", "exact connector title for this workspace")
  .option("--protocol-state <state>", "checkpoint protocol state, e.g. EXECUTED_SENT")
  .option("--waiting-for <who>", "none | GPT_PLAN | GPT_REVIEW | USER")
  .option("--goal <text>", "original task goal for resume / HANDOFF")
  .option("--completed-subtasks <text>")
  .option("--known-issues <text>")
  .option("--next-step <text>")
  .option("--clear-checkpoint", "drop the active checkpoint (task DONE)", false)
  .action(
    (opts: {
      workspace?: string;
      url?: string;
      title?: string;
      task?: string;
      iteration?: string;
      state?: string;
      mode?: string;
      projectUrl?: string;
      connectorName?: string;
      protocolState?: string;
      waitingFor?: string;
      goal?: string;
      completedSubtasks?: string;
      knownIssues?: string;
      nextStep?: string;
      clearCheckpoint: boolean;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const modeRaw = opts.mode?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "long-chat" && modeRaw !== "project") {
        throw new Error("mode must be long-chat or project");
      }
      const protocolRaw = opts.protocolState?.trim().toUpperCase();
      if (protocolRaw && !PROTOCOL_STATES.includes(protocolRaw as ProtocolState)) {
        throw new Error(`protocol-state must be one of ${PROTOCOL_STATES.join(", ")}`);
      }
      const waitingRaw = opts.waitingFor?.trim();
      const waitingNorm = waitingRaw
        ? waitingRaw.toLowerCase() === "none"
          ? "none"
          : waitingRaw.toUpperCase()
        : undefined;
      if (waitingNorm && !WAITING_FOR.includes(waitingNorm as WaitingFor)) {
        throw new Error(`waiting-for must be one of ${WAITING_FOR.join(", ")}`);
      }
      const saved = mergeSession(readSession(workspace.id), {
        url: opts.url,
        title: opts.title,
        taskId: opts.task,
        iteration: opts.iteration ? parseInt(opts.iteration, 10) : undefined,
        lastState: opts.state,
        conversationMode: modeRaw as ConversationMode | undefined,
        projectUrl: opts.projectUrl,
        connectorName: opts.connectorName,
        clearCheckpoint: opts.clearCheckpoint,
        checkpoint: protocolRaw
          ? {
              protocolState: protocolRaw as ProtocolState,
              waitingFor: (waitingNorm as WaitingFor | undefined) ?? undefined,
              originalGoal: opts.goal,
              completedSubtasks: opts.completedSubtasks,
              knownIssues: opts.knownIssues,
              nextExpectedStep: opts.nextStep,
            }
          : undefined,
      });
      writeSession(workspace.id, saved);
      if (saved.projectUrl && saved.conversationMode === "project") {
        check("已记录 ChatGPT 合集，后续从合集页新开或复用对话");
      } else {
        check("已记录 ChatGPT 会话，后续任务将复用");
      }
    }
  );

session
  .command("clear")
  .description("Forget the current ChatGPT chat (Project binding is kept)")
  .option("-w, --workspace <path>")
  .action((opts: { workspace?: string }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const result = clearChatPointer(workspace.id);
    if (!result.cleared) say("尚未记录 ChatGPT 会话。");
    else if (result.keptProject) check("已清除当前对话，合集绑定仍保留");
    else check("已清除会话记录，下次任务将新建 ChatGPT 会话");
  });

const prefsCmd = program
  .command("prefs")
  .description("Remember ChatGPT developer mode and setup choice for this machine");

prefsCmd
  .command("get", { isDefault: true })
  .description("Show remembered ChatGPT setup choices (not per workspace)")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const prefs = readUiPrefs();
    if (opts.json) {
      say(JSON.stringify({ ok: true, ...prefs }));
      return;
    }
    say(prefs.developerModeEnabled ? "开发人员模式：已记住已开启" : "开发人员模式：尚未记住");
    if (prefs.setupMode === "auto") say("配置方式：AI 自动化配置（预览版）");
    else if (prefs.setupMode === "manual") say("配置方式：手动教学配置");
    else say("配置方式：尚未选择");
  });

prefsCmd
  .command("set")
  .description("Save a ChatGPT setup choice for this machine")
  .option("--developer-mode", "remember that ChatGPT developer mode is on", false)
  .option("--setup-mode <mode>", "auto (preview) or manual")
  .option("--json", "machine-readable output", false)
  .action((opts: { developerMode: boolean; setupMode?: string; json: boolean }) => {
    try {
      const modeRaw = opts.setupMode?.trim().toLowerCase();
      if (modeRaw && !SETUP_MODES.includes(modeRaw as SetupMode)) {
        throw new Error(`setup-mode must be one of ${SETUP_MODES.join(", ")}`);
      }
      if (!opts.developerMode && !modeRaw) {
        throw new Error("nothing to save: pass --developer-mode and/or --setup-mode");
      }
      const prefs = mergeUiPrefs({
        developerModeEnabled: opts.developerMode ? true : undefined,
        setupMode: modeRaw as SetupMode | undefined,
      });
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...prefs }));
        return;
      }
      if (opts.developerMode) check("已记住开发人员模式已开启");
      if (modeRaw === "auto") check("已记住配置方式：AI 自动化配置（预览版）");
      if (modeRaw === "manual") check("已记住配置方式：手动教学配置");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .option("--command <text>", "command whose output may be offered to ChatGPT")
  .option("--output <text>", "command output (prefer --output-file for long logs)")
  .option("--output-file <path>", "read command output from a local file")
  .option("--exit-code <n>", "numeric exit code of that command")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
      command?: string;
      output?: string;
      outputFile?: string;
      exitCode?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      let outputId: number | undefined;
      let outputAvailable = false;
      const rawOutput =
        opts.outputFile !== undefined
          ? readCappedUtf8(path.resolve(opts.outputFile), MAX_RECORD_OUTPUT_READ)
          : opts.output;
      if (opts.command && rawOutput !== undefined) {
        const savedOutput = saveExecutionOutput(workspace.id, {
          command: opts.command,
          raw: rawOutput,
          exitCode: opts.exitCode !== undefined ? parseInt(opts.exitCode, 10) : null,
          taskId: opts.task,
          iteration: parseInt(opts.iteration, 10),
        });
        outputId = savedOutput.id;
        outputAvailable = savedOutput.allowed;
      }
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        // The legacy local recorder has no network input; its effective
        // policy is the safe default and is persisted explicitly.
        network: false,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes?.slice(0, 400),
        outputId,
        outputAvailable,
      });
      if (outputId !== undefined && !outputAvailable) check("已记录执行摘要（输出未对 ChatGPT 开放）");
      else if (outputId !== undefined) check("已记录执行摘要与输出");
      else check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .action((opts: { workspace?: string; zone?: string; json: boolean; stateDir?: string }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone, opts.stateDir);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) {
        say("尚未选择公网连接。请使用显式参数：");
        say("  c2c tunnel choose --mode quick");
        say("  c2c tunnel choose --mode named --zone <domain> --hostname <host>");
      }
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .option("--state-dir <path>", "explicit C2C state directory")
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean; stateDir?: string }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id, opts.stateDir);
      if (mode === "quick") {
        const state = chooseQuickTunnel(workspace.id);
        if (await findLiveBridge(workspace.id, workspace.root, { stateDir: opts.stateDir })) {
          if (previous.preference === "named") await stopBridge(root, { stateDir: opts.stateDir });
        }
        const payload = { ...tunnelChoicePayload(workspace, undefined, opts.stateDir), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }
      if (mode !== "named") {
        throw new Error("mode must be quick or named");
      }
      const zone = parseZoneInput(opts.zone ?? "") ?? parseZoneInput(previous.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const result = await provisionNamedTunnel({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        zone,
        hostname: opts.hostname ?? previous.hostname,
        fallbackOnFailure: false,
      });
      const payload = {
        ...tunnelChoicePayload(workspace, undefined, opts.stateDir),
        ok: result.ok,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (result.ok && await findLiveBridge(workspace.id, workspace.root)) await stopBridge(root);
      if (opts.json) {
        say(JSON.stringify(payload));
        if (!result.ok) process.exitCode = 1;
        return;
      }
      if (!result.ok) cross(result.error ?? "固定域名配置失败");
      else if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
      if (!result.ok) process.exitCode = 1;
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

function explicitStateDirFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--state-dir") return argv[index + 1];
    if (value?.startsWith("--state-dir=")) return value.slice("--state-dir=".length);
  }
  return undefined;
}

try {
  // Freeze the process-wide state context before Commander invokes any action
  // or any Logger/state helper can observe a packaged-parent environment.
  // Single-namespace here: initializeStateDir already resolved precedence, and
  // in-process A2C_* writes would outlive the command and shadow later
  // C2C_* stubs in embedded/test contexts. Spawned children get BOTH names
  // (daemon.ts / restart.ts dual-write the handoff environment).
  const stateContext = initializeStateDir(explicitStateDirFromArgv(process.argv.slice(2)));
  process.env.C2C_STATE_DIR = stateContext.stateDir; // legacy-compatible in-process name
} catch (error) {
  cross(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
