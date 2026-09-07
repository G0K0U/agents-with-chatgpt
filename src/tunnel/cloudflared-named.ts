import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import type { Logger } from "../logger/index.js";
import { nullLogger } from "../logger/index.js";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { findBinary } from "./detect.js";
import {
  namedTunnelConfigFile,
  namedTunnelRuntimeFile,
} from "./state.js";
import type { TunnelDoctorReport, TunnelProvider, TunnelStatus } from "./provider.js";

const CONNECTED_RE = /registered tunnel connection/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/i;
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const ENV_OVERRIDES = [
  "TUNNEL_CONFIG",
  "TUNNEL_URL",
  "TUNNEL_HOSTNAME",
  "TUNNEL_NAME",
  "TUNNEL_CRED_FILE",
  "TUNNEL_CREDENTIALS_FILE",
  "TUNNEL_TOKEN",
  "TUNNEL_TOKEN_FILE",
  "TUNNEL_FORCE_PROVISIONING_DNS",
  "TUNNEL_ORIGIN_CERT",
] as const;

export interface CloudflaredNamedTunnelOptions {
  /** Workspace id is used to keep each ingress config isolated in app state. */
  workspaceId?: string;
  tunnelName: string;
  /** UUID is required for a managed, credential-file-backed named tunnel. */
  tunnelId?: string;
  hostname: string;
  logger?: Logger;
  /** Immutable C2C state domain for tunnel runtime metadata. */
  stateDir?: string;
  binaryOverride?: string;
  /** Test seam and migration seam; production derives this under the state dir. */
  configFile?: string;
  /** Test seam; production derives the standard cloudflared credential path. */
  credentialsFile?: string;
  startTimeoutMs?: number;
}

export interface NamedTunnelRuntime {
  pid: number;
  workspaceId: string;
  tunnelName: string;
  tunnelId: string;
  hostname: string;
  originPort: number;
  configFile: string;
  startedAt: string;
}

export interface NamedTunnelReconciliation {
  state: "none" | "stale-cleared" | "live-unknown";
  pid?: number;
  configFile?: string;
}

export function normalizeNamedTunnelHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!HOSTNAME_RE.test(normalized)) {
    throw new Error(`Invalid named tunnel hostname: ${hostname}`);
  }
  return normalized;
}

function normalizeTunnelId(tunnelId: string): string {
  const normalized = tunnelId.trim().toLowerCase();
  if (!UUID_RE.test(normalized)) throw new Error(`Invalid Cloudflare tunnel id: ${tunnelId}`);
  return normalized;
}

function normalizeTunnelName(tunnelName: string): string {
  const normalized = tunnelName.trim();
  if (!NAME_RE.test(normalized) || normalized.length > 128) {
    throw new Error("Named tunnel name must contain only letters, numbers, dots, hyphens or underscores");
  }
  return normalized;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function yamlSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Render only the bridge-owned ingress that the named tunnel is allowed to serve. */
export function renderNamedTunnelConfig(opts: {
  tunnelId: string;
  credentialsFile: string;
  hostname: string;
  localPort: number;
}): string {
  const tunnelId = normalizeTunnelId(opts.tunnelId);
  const hostname = normalizeNamedTunnelHostname(opts.hostname);
  if (!validPort(opts.localPort)) throw new Error(`Invalid local tunnel port: ${opts.localPort}`);
  if (!opts.credentialsFile.trim()) throw new Error("Named tunnel credentials file is required");
  return [
    `tunnel: ${tunnelId}`,
    `credentials-file: ${yamlSingleQuote(path.resolve(opts.credentialsFile))}`,
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: ${yamlSingleQuote(`http://127.0.0.1:${opts.localPort}`)}`,
    "  - service: 'http_status:404'",
    "",
  ].join("\n");
}

export function namedTunnelLaunchArgs(configFile: string, tunnelId: string): string[] {
  return ["tunnel", "--no-autoupdate", "--config", path.resolve(configFile), "run", normalizeTunnelId(tunnelId)];
}

function cleanCloudflaredEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ENV_OVERRIDES) delete env[key];
  return env;
}

function writeAtomicText(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      fs.chmodSync(temporary, 0o600);
    } catch {
      // best effort on platforms without chmod semantics
    }
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temporary, file);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
}

function removeFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // best effort; a later start will fail closed if state cannot be reconciled
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isRuntime(value: unknown): value is NamedTunnelRuntime {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<NamedTunnelRuntime>;
  return (
    Number.isInteger(row.pid) &&
    typeof row.workspaceId === "string" &&
    typeof row.tunnelName === "string" &&
    typeof row.tunnelId === "string" &&
    typeof row.hostname === "string" &&
    Number.isInteger(row.originPort) &&
    typeof row.configFile === "string" &&
    typeof row.startedAt === "string"
  );
}

/** Remove dead launch metadata, but never kill an uncertain PID automatically. */
export function reconcileNamedTunnelRuntime(workspaceId: string, stateDir?: string): NamedTunnelReconciliation {
  const file = namedTunnelRuntimeFile(workspaceId, stateDir);
  const runtime = readJsonIfExists<unknown>(file);
  if (!runtime) return { state: "none" };
  if (!isRuntime(runtime)) {
    removeFile(file);
    return { state: "stale-cleared" };
  }
  if (isProcessAlive(runtime.pid)) {
    return { state: "live-unknown", pid: runtime.pid, configFile: runtime.configFile };
  }
  removeFile(file);
  return { state: "stale-cleared", pid: runtime.pid, configFile: runtime.configFile };
}

function defaultCredentialsFile(tunnelId: string): string {
  return path.join(os.homedir(), ".cloudflared", `${tunnelId}.json`);
}

/**
 * Locally-managed Cloudflare named tunnel.
 *
 * The tunnel object and DNS route are provisioned once with cloudflared.  A
 * fresh, atomic, machine-local ingress file is rendered for every bridge
 * port.  The process is launched by UUID with that file; no `--url` shortcut,
 * shell, token, or workspace-controlled argument participates in the launch.
 */
export class CloudflaredNamedTunnel implements TunnelProvider {
  private readonly stateDir: string;
  readonly name = "cloudflare-named";
  private readonly workspaceId?: string;
  private readonly tunnelName: string;
  private readonly tunnelId?: string;
  private readonly hostname: string;
  private readonly logger: Logger;
  private readonly binaryOverride?: string;
  private readonly configPath: string;
  private readonly credentialsPath?: string;
  private readonly startTimeoutMs: number;
  private child: ChildProcess | null = null;
  private connected = false;
  private activePort: number | null = null;
  private lastError: string | null = null;
  private startInFlight: Promise<string> | null = null;

  constructor(opts: CloudflaredNamedTunnelOptions) {
    this.stateDir = getStateDir(opts.stateDir);
    this.workspaceId = opts.workspaceId;
    this.tunnelName = normalizeTunnelName(opts.tunnelName);
    this.tunnelId = opts.tunnelId ? normalizeTunnelId(opts.tunnelId) : undefined;
    this.hostname = normalizeNamedTunnelHostname(opts.hostname);
    this.logger = opts.logger ?? nullLogger;
    this.binaryOverride = opts.binaryOverride;
    this.configPath = path.resolve(
      opts.configFile ?? (this.workspaceId ? namedTunnelConfigFile(this.workspaceId, this.stateDir) : path.join(this.stateDir, "tunnels", `${this.tunnelName}.yml`))
    );
    if (!pathWithin(this.stateDir, this.configPath)) {
      throw new Error("Named tunnel config must remain under the C2C machine state directory");
    }
    this.credentialsPath = this.tunnelId
      ? path.resolve(opts.credentialsFile ?? defaultCredentialsFile(this.tunnelId))
      : undefined;
    this.startTimeoutMs = opts.startTimeoutMs ?? 45_000;
  }

  private binary(): string | null {
    return this.binaryOverride ?? findBinary("cloudflared");
  }

  private publicUrl(): string {
    return `https://${this.hostname}`;
  }

  private launchArgs(): string[] {
    if (!this.tunnelId) throw new Error("Named tunnel state is missing tunnelId; provision the fixed hostname again");
    return namedTunnelLaunchArgs(this.configPath, this.tunnelId);
  }

  private credentialsFile(): string {
    if (!this.credentialsPath) throw new Error("Named tunnel state is missing tunnelId; provision the fixed hostname again");
    const cloudflaredDir = path.resolve(os.homedir(), ".cloudflared");
    if (!pathWithin(cloudflaredDir, this.credentialsPath)) {
      throw new Error("Named tunnel credentials must remain under the user's .cloudflared directory");
    }
    try {
      if (!fs.statSync(this.credentialsPath).isFile()) throw new Error("not a regular file");
    } catch {
      throw new Error(`Cloudflare tunnel credentials not found: ${this.credentialsPath}`);
    }
    return this.credentialsPath;
  }

  private persistRuntime(pid: number, originPort: number): void {
    if (!this.workspaceId) return;
    const runtime: NamedTunnelRuntime = {
      pid,
      workspaceId: this.workspaceId,
      tunnelName: this.tunnelName,
      tunnelId: this.tunnelId!,
      hostname: this.hostname,
      originPort,
      configFile: this.configPath,
      startedAt: new Date().toISOString(),
    };
    writeSecureJson(namedTunnelRuntimeFile(this.workspaceId, this.stateDir), runtime);
  }

  private clearRuntime(pid?: number): void {
    if (!this.workspaceId) return;
    const current = readJsonIfExists<unknown>(namedTunnelRuntimeFile(this.workspaceId, this.stateDir));
    if (!pid || (isRuntime(current) && current.pid === pid) || !current) {
      removeFile(namedTunnelRuntimeFile(this.workspaceId, this.stateDir));
    }
  }

  private async startInternal(localPort: number): Promise<string> {
    if (!validPort(localPort)) throw new Error(`Invalid local tunnel port: ${localPort}`);
    const bin = this.binary();
    if (!bin) {
      throw new Error(
        "cloudflared is not installed. Install it (e.g. `brew install cloudflared`) and retry."
      );
    }
    const credentialsFile = this.credentialsFile();
    const reconciliation = this.workspaceId
      ? reconcileNamedTunnelRuntime(this.workspaceId, this.stateDir)
      : { state: "none" as const };
    if (reconciliation.state === "live-unknown") {
      throw new Error(
        `A previous named tunnel process is still alive (pid ${reconciliation.pid}); refusing to overwrite its origin config`
      );
    }
    writeAtomicText(
      this.configPath,
      renderNamedTunnelConfig({
        tunnelId: this.tunnelId!,
        credentialsFile,
        hostname: this.hostname,
        localPort,
      })
    );
    const args = this.launchArgs();
    const child = spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanCloudflaredEnvironment(),
      windowsHide: true,
    });
    this.child = child;
    this.connected = false;
    this.activePort = localPort;
    this.lastError = null;
    if (!child.pid) throw new Error("cloudflared did not expose a process id");
    this.persistRuntime(child.pid, localPort);

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => {
        if (!this.connected) {
          this.lastError = "Named tunnel start timed out before registration";
          try {
            child.kill("SIGTERM");
          } catch {
            // exit handler will reconcile the runtime file
          }
          finish(() => reject(new Error(this.lastError ?? "Named tunnel start timed out")));
        }
      }, this.startTimeoutMs);

      const scan = (stream: NodeJS.ReadableStream): void => {
        const rl = readline.createInterface({ input: stream });
        rl.on("line", (line) => {
          if (CONNECTED_RE.test(line) && !this.connected) {
            this.connected = true;
            const url = this.publicUrl();
            this.logger.info(`Named tunnel process registered: ${url}`);
            finish(() => resolve(url));
          }
          if (/\b(error|failed|fatal)\b/i.test(line)) {
            this.lastError = line.slice(0, 400);
            this.logger.debug(`cloudflared: ${line.slice(0, 400)}`);
          }
        });
      };
      if (child.stdout) scan(child.stdout);
      if (child.stderr) scan(child.stderr);

      child.on("error", (error) => {
        if (this.child === child) {
          this.child = null;
          this.connected = false;
          this.activePort = null;
        }
        this.clearRuntime(child.pid);
        finish(() => reject(error));
      });
      child.on("exit", (code) => {
        const wasStarting = !this.connected;
        this.logger.warn(`cloudflared named tunnel exited with code ${code}`);
        if (this.child === child) {
          this.child = null;
          this.connected = false;
          this.activePort = null;
        }
        this.clearRuntime(child.pid);
        if (wasStarting) {
          finish(() =>
            reject(
              new Error(
                `cloudflared exited (code ${code}) before establishing the named tunnel${
                  this.lastError ? `: ${this.lastError}` : ""
                }`
              )
            )
          );
        }
      });
    });
  }

  async start(localPort: number): Promise<string> {
    if (this.child && this.connected && this.activePort === localPort) return this.publicUrl();
    if (this.startInFlight) return this.startInFlight;
    if (this.child) await this.stop();
    const operation = this.startInternal(localPort);
    this.startInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.startInFlight === operation) this.startInFlight = null;
    }
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.connected = false;
    this.activePort = null;
    if (!child) {
      const runtime = this.workspaceId ? readJsonIfExists<unknown>(namedTunnelRuntimeFile(this.workspaceId, this.stateDir)) : null;
      if (!runtime || !isRuntime(runtime) || !isProcessAlive(runtime.pid)) this.clearRuntime();
      return;
    }
    const exited = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    });
    try {
      child.kill("SIGTERM");
    } catch {
      // The process may already have exited; the bounded wait below handles it.
    }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort on platforms that do not expose SIGKILL semantics
      }
    }
    this.clearRuntime(child.pid);
  }

  async restart(localPort: number): Promise<string> {
    await this.stop();
    return this.start(localPort);
  }

  status(): TunnelStatus {
    const bin = this.binary();
    const args = this.tunnelId ? namedTunnelLaunchArgs(this.configPath, this.tunnelId) : [];
    return {
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      provider: this.name,
      detail: this.lastError ?? undefined,
      originPort: this.activePort,
      hostname: this.hostname,
      tunnelId: this.tunnelId ?? null,
      configFile: this.configPath,
      executable: bin,
      argv: args,
    };
  }

  getPublicUrl(): string | null {
    return this.connected ? this.publicUrl() : null;
  }

  async doctor(): Promise<TunnelDoctorReport> {
    const bin = this.binary();
    const problems: string[] = [];
    if (!bin) problems.push("cloudflared binary not found");
    if (!this.tunnelId) problems.push("named tunnel id is missing");
    if (this.tunnelId) {
      try {
        this.credentialsFile();
      } catch (error) {
        problems.push((error as Error).message);
      }
    }
    if (bin && !this.child) problems.push("named tunnel process not running");
    if (this.child && !this.connected) problems.push("named tunnel is not connected yet");
    return {
      provider: this.name,
      binaryFound: bin !== null,
      binaryPath: bin,
      running: this.child !== null && this.connected,
      url: this.connected ? this.publicUrl() : null,
      problems,
      originPort: this.activePort,
      hostname: this.hostname,
      tunnelId: this.tunnelId ?? null,
      configFile: this.configPath,
      executable: bin,
      argv: this.tunnelId ? namedTunnelLaunchArgs(this.configPath, this.tunnelId) : [],
    };
  }
}
