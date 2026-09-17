import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * Owns the `zcode app-server` child process and the raw stdio framing.
 * Emits parsed protocol messages on "message".
 */
export class ZcodeProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private buffer = "";
  private exitWaiters: Array<(code: number | null) => void> = [];
  private malformedCount = 0;

  constructor(
    private readonly nodePath: string,
    private readonly cliPath: string,
    private readonly childEnv: Record<string, string>,
  ) {
    super();
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.nodePath, [this.cliPath, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.childEnv },
      windowsHide: true,
    });
    this.buffer = "";
    const child = this.child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => this.emit("stderr", chunk));
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

  get malformedMessageCount(): number {
    return this.malformedCount;
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
