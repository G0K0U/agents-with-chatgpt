import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCliSpawn } from "../../config.js";

/**
 * Owns the `zcode app-server` child process and the raw stdio framing.
 * Emits parsed protocol messages on "message".
 */
export class ZcodeProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = "";
  private exitWaiters: Array<(code: number | null) => void> = [];
  private malformedCount = 0;
  private recentStderr: string[] = [];

  constructor(
    private readonly nodePath: string,
    private readonly cliPath: string,
    private readonly childEnv: Record<string, string>,
  ) {
    super();
  }

  /** Overridable argv after the CLI path (official lane appends --stdio). */
  protected argv(): string[] {
    return ["app-server"];
  }

  /** Overridable child env (official lane supplies a scrubbed full env). */
  protected buildEnv(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.childEnv };
  }

  start(): void {
    if (this.child) return;
    const { command, args } = resolveCliSpawn(this.cliPath, this.argv(), this.nodePath);
    this.child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: this.buildEnv(),
      windowsHide: true,
    });
    this.buffer = "";
    const child = this.child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.emit("stderr", chunk);
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) {
          this.recentStderr.push(trimmed);
          if (this.recentStderr.length > 50) this.recentStderr.shift();
        }
      }
      try {
        const stateDir = process.env.Z2C_STATE_DIR ?? join(process.env.LOCALAPPDATA ?? "", "z2c");
        appendFileSync(join(stateDir, "zcode-agent-stderr.log"), chunk);
      } catch {}
    });
    child.on("exit", (code) => {
      this.child = null;
      this.emit("exit", code);
      for (const w of this.exitWaiters.splice(0)) w(code);
    });
    child.on("error", (err) => this.emit("spawn-error", err));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as unknown;
        this.emit("message", msg);
      } catch {
        // Protocol corruption must be visible, never silently ignored.
        this.malformedCount++;
        this.emit("malformed", line.slice(0, 400));
      }
    }
  }

  write(message: unknown): void {
    const stdin = this.child?.stdin;
    if (!this.child || !stdin || !stdin.writable) {
      throw new Error("app-server process is not running");
    }
    stdin.write(JSON.stringify(message) + "\n");
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** OS pid of the child while running (daemon child tracking). */
  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  get malformedMessageCount(): number {
    return this.malformedCount;
  }

  getLastStderrError(): string | null {
    if (this.recentStderr.length === 0) return null;
    const errLine = [...this.recentStderr].reverse().find((l) =>
      /Error[:\s]|failed|rejected|limit reached|status \d{3}/i.test(l),
    );
    return errLine ? errLine.trim() : this.recentStderr.at(-1)?.trim() ?? null;
  }

  kill(): void {
    this.child?.kill();
    this.child = null;
  }

  waitExit(timeoutMs: number): Promise<number | null> {
    if (!this.child) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.exitWaiters.indexOf(waiter);
        if (i >= 0) this.exitWaiters.splice(i, 1);
        this.kill();
        resolve(null);
      }, timeoutMs);
      const waiter = (code: number | null) => {
        clearTimeout(timer);
        resolve(code);
      };
      this.exitWaiters.push(waiter);
    });
  }
}
