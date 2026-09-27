import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type AuditLevel = "info" | "warn" | "error";

export interface AuditSink {
  record(level: AuditLevel, event: string, fields?: Record<string, unknown>): void;
}

/**
 * Bounded audit log. Records operational metadata only:
 * never credentials, tokens, model reasoning, or full session contents.
 */
export class FileAuditLog implements AuditSink {
  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "audit.log");
  }
  readonly path: string;

  record(level: AuditLevel, event: string, fields?: Record<string, unknown>): void {
    const line =
      JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n";
    try {
      appendFileSync(this.path, line);
    } catch {
      // auditing must never crash the control plane
    }
  }
}
