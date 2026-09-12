import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Logger } from "../logger/index.js";
import { VERSION } from "../version.js";

/**
 * The bridge speaks only the official Codex App Server JSONL protocol.  The
 * executable and arguments are intentionally fixed; callers cannot turn this
 * adapter into a general command runner.
 */
const CODEX_ARGS = ["app-server", "--stdio"] as const;
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;

export type CodexExecutableResolutionErrorCode =
  | "CODEX_EXECUTABLE_OVERRIDE_INVALID"
  | "CODEX_EXECUTABLE_NOT_FOUND";

/** A path-free launcher error that is safe to persist in task records. */
export class CodexExecutableResolutionError extends Error {
  constructor(public readonly code: CodexExecutableResolutionErrorCode, message: string) {
    super(message);
    this.name = "CodexExecutableResolutionError";
  }
}

export interface CodexExecutableResolutionOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  execPath?: string;
  modulePath?: string;
  /** Test seam for checking exact, bounded candidates without scanning. */
  isFile?: (candidate: string) => boolean;
}

function isRegularFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function windowsPackageTarget(arch: string): { packageName: string; triple: string } | null {
  if (arch === "x64") return { packageName: "codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  if (arch === "arm64") return { packageName: "codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  return null;
}

function addPackageRoot(roots: string[], seen: Set<string>, candidate: string, pathApi: typeof path.win32): void {
  if (!pathApi.isAbsolute(candidate)) return;
  const normalized = pathApi.normalize(candidate);
  const key = normalized.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  roots.push(normalized);
}

/**
 * Resolve the fixed App Server executable without a shell or PATH search.
 *
 * Windows candidates are exact paths in the official package layout, derived
 * from the managed Codex package, the running Node installation, this module's
 * installation ancestors, or a standard npm prefix. No directory is listed or
 * recursively searched.
 */
export function resolveCodexExecutable(options: CodexExecutableResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const execPath = options.execPath ?? process.execPath;
  const modulePath = options.modulePath ?? fileURLToPath(import.meta.url);
  const isFile = options.isFile ?? isRegularFile;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = env.C2C_CODEX_EXECUTABLE;

  if (override !== undefined) {
    if (!override || !pathApi.isAbsolute(override) || !isFile(override)) {
      throw new CodexExecutableResolutionError(
        "CODEX_EXECUTABLE_OVERRIDE_INVALID",
        "C2C_CODEX_EXECUTABLE must reference an absolute existing regular file"
      );
    }
    if (platform === "win32" && pathApi.extname(override).toLowerCase() !== ".exe") {
      throw new CodexExecutableResolutionError(
        "CODEX_EXECUTABLE_OVERRIDE_INVALID",
        "C2C_CODEX_EXECUTABLE must reference a native .exe file on Windows"
      );
    }
    return pathApi.normalize(override);
  }

  if (platform !== "win32") return "codex";

  const target = windowsPackageTarget(arch);
  if (!target) {
    throw new CodexExecutableResolutionError(
      "CODEX_EXECUTABLE_NOT_FOUND",
      "No native Codex executable is available for this Windows architecture"
    );
  }

  const packageRoots: string[] = [];
  const seenRoots = new Set<string>();
  if (env.CODEX_MANAGED_PACKAGE_ROOT) {
    addPackageRoot(packageRoots, seenRoots, env.CODEX_MANAGED_PACKAGE_ROOT, path.win32);
  }
  addPackageRoot(
    packageRoots,
    seenRoots,
    path.win32.join(path.win32.dirname(execPath), "node_modules", "@openai", "codex"),
    path.win32
  );

  // A global C2C install and @openai/codex commonly share a node_modules
  // ancestor. Check only a small fixed number of exact ancestor-derived paths.
  let current = path.win32.dirname(modulePath);
  for (let depth = 0; depth < 8; depth += 1) {
    if (path.win32.basename(current).toLowerCase() === "node_modules") {
      addPackageRoot(
        packageRoots,
        seenRoots,
        path.win32.join(current, "@openai", "codex"),
        path.win32
      );
    }
    addPackageRoot(
      packageRoots,
      seenRoots,
      path.win32.join(current, "node_modules", "@openai", "codex"),
      path.win32
    );
    const parent = path.win32.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (env.npm_config_prefix) {
    addPackageRoot(
      packageRoots,
      seenRoots,
      path.win32.join(env.npm_config_prefix, "node_modules", "@openai", "codex"),
      path.win32
    );
  }
  if (env.APPDATA) {
    addPackageRoot(
      packageRoots,
      seenRoots,
      path.win32.join(env.APPDATA, "npm", "node_modules", "@openai", "codex"),
      path.win32
    );
  }

  for (const packageRoot of packageRoots) {
    const candidates = [
      path.win32.join(
        packageRoot,
        "node_modules",
        "@openai",
        target.packageName,
        "vendor",
        target.triple,
        "bin",
        "codex.exe"
      ),
      path.win32.join(packageRoot, "vendor", target.triple, "bin", "codex.exe"),
    ];
    for (const candidate of candidates) {
      if (isFile(candidate)) return path.win32.normalize(candidate);
    }
  }

  throw new CodexExecutableResolutionError(
    "CODEX_EXECUTABLE_NOT_FOUND",
    "No native Codex executable was found in the installed Codex package"
  );
}

// The official Codex MCP launcher does not forward arbitrary parent-process
// environment variables.  Keep this override fixed and local: it reuses the
// already configured official Serena server definition while explicitly
// allowing only the bridge-owned SERENA_HOME value through to that child.
// This is configuration for the fixed App Server, not a caller-provided CLI.
const SERENA_RUNTIME_CONFIG_OVERRIDE =
  'mcp_servers.serena={command="uvx",args=["--offline","--from","git+https://github.com/oraios/serena","serena","start-mcp-server","--context","claude-code","--project-from-cwd"],env_vars=["SERENA_HOME"]}';

// Offline C2C coding turns have no network-capable MCP surface. Start from an
// empty MCP table so arbitrary user-configured servers cannot become a side
// channel. An explicitly network-enabled task is the only case that preserves
// the normal local Codex MCP configuration.
const C2C_MCP_SERVERS_DISABLED = "mcp_servers={}";
const C2C_FIRECRAWL_DISABLED = "mcp_servers.firecrawl.enabled=false";

export type RpcId = string | number;

export interface AppServerRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface AppServerNotification {
  method: string;
  params?: unknown;
}

export interface AppServerClient {
  initialize(): Promise<void>;
  request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): void;
  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void;
  setRequestHandler(handler: (request: AppServerRequest) => void | Promise<void>): void;
  respond(id: RpcId, result: unknown): void;
  respondError(id: RpcId, code: number, message: string): void;
  close(): Promise<void>;
}

export interface AppServerFactoryOptions {
  workspaceRoot: string;
  logger: Logger;
  /** Bridge-owned child-process environment; never populated from task input. */
  env?: NodeJS.ProcessEnv;
  /** Explicit local filesystem/process deployment mode selected by the local bridge supervisor. */
  fullAccess?: boolean;
  /** Effective per-task network policy; defaults to disabled. */
  networkAccess?: boolean;
  /**
   * Enables the fixed C2C Serena config layer for this App Server process.
   * The value is prepared and validated locally by CodexTaskManager.
   */
  serenaRuntimeHome?: string;
}

export type AppServerFactory = (opts: AppServerFactoryOptions) => AppServerClient;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface RpcMessage {
  id?: RpcId;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Build the fixed C2C App Server argv without accepting caller-supplied CLI text. */
export function codexAppServerArgs(opts: AppServerFactoryOptions): string[] {
  const args: string[] = [...CODEX_ARGS];
  // Full filesystem/process access does not implicitly enable network access.
  // Keep the fixed MCP surface offline unless the task explicitly opted in
  // and the local deployment authorized that capability upstream.
  const networkEnabled = opts.fullAccess === true && opts.networkAccess === true;
  if (!networkEnabled) args.push("-c", C2C_MCP_SERVERS_DISABLED);
  if (opts.serenaRuntimeHome) {
    if (opts.env?.SERENA_HOME !== opts.serenaRuntimeHome) {
      throw new Error("C2C Serena runtime environment is incomplete");
    }
    args.push("-c", SERENA_RUNTIME_CONFIG_OVERRIDE);
  }
  // Explicitly disable the known web-MCP regression in every offline task.
  if (!networkEnabled) args.push("-c", C2C_FIRECRAWL_DISABLED);
  return args;
}

export class CodexAppServerClient implements AppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private stdoutBuffer = "";
  private nextId = 1;
  private closed = false;
  private terminalError: Error | null = null;
  private notificationHandler: ((notification: AppServerNotification) => void | Promise<void>) | null = null;
  private requestHandler: ((request: AppServerRequest) => void | Promise<void>) | null = null;

  constructor(
    private readonly opts: AppServerFactoryOptions,
    private readonly launcher: { resolveExecutable?: () => string; spawn?: typeof spawn } = {}
  ) {}

  async initialize(): Promise<void> {
    if (this.child) return;
    if (this.closed) throw new Error("Codex App Server client is closed");

    // Installed dangerFullAccess has no networkAccess field. MCP tool removal
    // cannot stop a host shell from networking. Fail before spawning, not online.
    if (this.opts.fullAccess === true && this.opts.networkAccess !== true) {
      throw new Error("NETWORK_POLICY_UNSUPPORTED: Codex full-access execution cannot enforce network=false; no provider was launched");
    }
    const executable = (this.launcher.resolveExecutable ?? resolveCodexExecutable)();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = (this.launcher.spawn ?? spawn)(executable, codexAppServerArgs(this.opts), {
        cwd: this.opts.workspaceRoot,
        env: { ...process.env, ...this.opts.env },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new Error(`Unable to start the Codex App Server: ${asError(error).message}`);
    }
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.opts.logger.warn("Codex App Server stderr", { text: text.slice(0, 4000) });
    });
    child.once("error", (error) => this.fail(asError(error)));
    child.once("close", (code, signal) => {
      if (!this.closed && !this.terminalError) {
        this.fail(new Error(`Codex App Server exited (code=${code ?? "null"}, signal=${signal ?? "none"})`));
      }
    });

    try {
      await this.request(
        "initialize",
        {
          clientInfo: {
            name: "codex-with-chatgpt-c2c",
            title: "Codex with ChatGPT C2C Bridge",
            version: VERSION,
          },
          capabilities: {},
        },
        45_000
      );
      this.notify("initialized", {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  request<T>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex App Server client is closed"));
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.child) return Promise.reject(new Error("Codex App Server is not initialized"));

    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) payload.params = params;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(asError(error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed || this.terminalError || !this.child) return;
    const payload: Record<string, unknown> = { method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
  }

  setNotificationHandler(handler: (notification: AppServerNotification) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(handler: (request: AppServerRequest) => void | Promise<void>): void {
    this.requestHandler = handler;
  }

  respond(id: RpcId, result: unknown): void {
    if (this.closed || !this.child) return;
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    if (this.closed || !this.child) return;
    this.write({ id, error: { code, message } });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const error = this.terminalError ?? new Error("Codex App Server client closed");
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    const child = this.child;
    this.child = null;
    if (!child) return;
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      child.stdin.end();
    } catch {
      // The process may already have exited.
    }
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // Best effort: the close event will still release resources.
      }
    }
    // The official Windows App Server uses connection closure as the fallback
    // termination mechanism for buffered command/exec sessions. Keep this
    // bounded so cancellation and shutdown cannot leave a dangling promise.
    await closed;
  }

  private write(payload: Record<string, unknown>): void {
    const child = this.child;
    if (!child || this.closed || this.terminalError) throw new Error("Codex App Server is unavailable");
    child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    this.stdoutBuffer += this.decoder.write(chunk);
    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES * 2) {
      this.fail(new Error("Codex App Server protocol output exceeded the safety limit"));
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
        this.fail(new Error("Codex App Server protocol line exceeded the safety limit"));
        return;
      }
      if (!line.trim()) continue;
      let message: RpcMessage;
      try {
        message = JSON.parse(line) as RpcMessage;
      } catch {
        this.fail(new Error("Codex App Server emitted invalid JSON"));
        return;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: RpcMessage): void {
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const code = typeof message.error.code === "number" ? ` (${message.error.code})` : "";
        pending.reject(new Error(`Codex App Server error${code}: ${String(message.error.message ?? "unknown error")}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method !== "string") return;
    if (message.id !== undefined) {
      const handler = this.requestHandler;
      if (!handler) {
        this.respondError(message.id, -32601, "No handler for this Codex App Server request");
        return;
      }
      void Promise.resolve(handler({ id: message.id, method: message.method, params: message.params })).catch((error) => {
        this.respondError(message.id!, -32603, asError(error).message.slice(0, 1000));
      });
      return;
    }
    const handler = this.notificationHandler;
    if (handler) {
      void Promise.resolve(handler({ method: message.method, params: message.params })).catch((error) => {
        this.opts.logger.warn("Codex App Server notification handler failed", { message: asError(error).message });
      });
    }
  }

  private fail(error: Error): void {
    if (this.terminalError || this.closed) return;
    this.terminalError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    const child = this.child;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Best effort.
      }
    }
  }
}

export const defaultAppServerFactory: AppServerFactory = (opts) => new CodexAppServerClient(opts);
