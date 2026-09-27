import { existsSync, readFileSync, renameSync, writeFileSync, appendFileSync, statSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentActivityEvent, AgentSessionRecord } from "./types.js";

/**
 * Durable storage for the shared session/activity plane.
 *
 *   <stateDir>/agent-plane/sessions.json   — projected session records (atomic)
 *   <stateDir>/agent-plane/activity.jsonl  — append-only activity events
 *
 * The store is a PROJECTION cache: providers' own stores (task files, session
 * registries, native runtime state) remain the source of truth. Activity keys
 * dedupe facts across syncs and restarts, so re-projection never duplicates
 * history. An empty stateDir degrades to in-process (enforcement unchanged).
 */

export const MAX_SESSION_RECORDS = 5000;
export const MAX_ACTIVITY_EVENTS = 4000;

interface SessionsFile {
  version: 1;
  updatedAt: string;
  sessions: AgentSessionRecord[];
}

export interface AppendableActivityEvent {
  key: string;
  at: string;
  type: AgentActivityEvent["type"];
  provider: AgentActivityEvent["provider"];
  workspaceId: string | null;
  sessionId: string | null;
  taskId: string | null;
  summary: string;
  outputRef?: { workspaceId: string; outputId: number } | null;
}

function sessionsFileFor(stateDir: string): string {
  return join(stateDir, "agent-plane", "sessions.json");
}

function activityFileFor(stateDir: string): string {
  return join(stateDir, "agent-plane", "activity.jsonl");
}

export class AgentPlaneStore {
  private activityKeys = new Set<string>();
  private lastSeq = 0;
  private activityLoaded = false;

  constructor(private readonly stateDir: string) {}

  // ── sessions ──────────────────────────────────────────────────────────────
  loadSessions(): AgentSessionRecord[] {
    if (!this.stateDir) return [];
    try {
      const raw = JSON.parse(readFileSync(sessionsFileFor(this.stateDir), "utf8")) as SessionsFile;
      if (raw?.version === 1 && Array.isArray(raw.sessions)) return raw.sessions;
    } catch {
      /* missing/corrupt → empty projection */
    }
    return [];
  }

  saveSessions(sessions: AgentSessionRecord[]): void {
    if (!this.stateDir) return;
    const file = sessionsFileFor(this.stateDir);
    mkdirSync(join(this.stateDir, "agent-plane"), { recursive: true });
    const payload: SessionsFile = {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: sessions.slice(-MAX_SESSION_RECORDS),
    };
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2));
    renameSync(tmp, file);
  }

  // ── activity ──────────────────────────────────────────────────────────────
  private loadActivity(): void {
    this.activityKeys.clear();
    this.lastSeq = 0;
    this.activityLoaded = true;
    if (!this.stateDir) return;
    const file = activityFileFor(this.stateDir);
    if (!existsSync(file)) return;
    try {
      const lines = readFileSync(file, "utf8").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as AgentActivityEvent;
          if (typeof event.seq === "number" && event.seq > this.lastSeq) this.lastSeq = event.seq;
          if (typeof event.key === "string") this.activityKeys.add(event.key);
        } catch {
          /* skip malformed line */
        }
      }
    } catch {
      /* unreadable activity log → start from empty index (events stay on disk) */
    }
  }

  /** Paginated read ordered by seq ascending; filters are conjunctive. */
  readActivity(opts?: {
    afterSeq?: number;
    limit?: number;
    provider?: string;
    sessionId?: string;
    workspaceId?: string;
  }): { events: AgentActivityEvent[]; lastSeq: number } {
    if (!this.activityLoaded) this.loadActivity();
    if (!this.stateDir) return { events: [], lastSeq: this.lastSeq };
    const file = activityFileFor(this.stateDir);
    if (!existsSync(file)) return { events: [], lastSeq: this.lastSeq };
    const limit = Math.max(1, Math.min(opts?.limit ?? 50, 100));
    const events: AgentActivityEvent[] = [];
    let lines: string[] = [];
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch {
      return { events: [], lastSeq: this.lastSeq };
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: AgentActivityEvent;
      try {
        event = JSON.parse(line) as AgentActivityEvent;
      } catch {
        continue;
      }
      if (opts?.afterSeq !== undefined && !(event.seq > opts.afterSeq)) continue;
      if (opts?.provider && event.provider !== opts.provider) continue;
      if (opts?.sessionId && event.sessionId !== opts.sessionId) continue;
      if (opts?.workspaceId && event.workspaceId !== opts.workspaceId) continue;
      events.push(event);
      if (events.length >= limit) break;
    }
    return { events, lastSeq: this.lastSeq };
  }

  /**
   * Append events deduped by stable key. Returns the number of events written.
   * Rotates the file at MAX_ACTIVITY_EVENTS so the projection stays bounded.
   */
  appendActivity(events: AppendableActivityEvent[]): number {
    if (events.length === 0) return 0;
    if (!this.activityLoaded) this.loadActivity();
    const fresh = events.filter((e) => e.key && !this.activityKeys.has(e.key));
    if (fresh.length === 0) return 0;
    if (!this.stateDir) {
      for (const e of fresh) this.activityKeys.add(e.key);
      this.lastSeq += fresh.length;
      return fresh.length;
    }
    const dir = join(this.stateDir, "agent-plane");
    mkdirSync(dir, { recursive: true });
    const file = activityFileFor(this.stateDir);
    const lines: string[] = [];
    for (const e of fresh) {
      const seq = ++this.lastSeq;
      this.activityKeys.add(e.key);
      lines.push(
        JSON.stringify({
          seq,
          key: e.key.slice(0, 200),
          at: e.at,
          type: e.type,
          provider: e.provider,
          workspaceId: e.workspaceId,
          sessionId: e.sessionId,
          taskId: e.taskId,
          summary: e.summary.slice(0, 300),
          outputRef: e.outputRef ?? null,
        }),
      );
    }
    try {
      if (existsSync(file)) {
        const size = statSync(file).size;
        const lineCount = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length;
        if (lineCount >= MAX_ACTIVITY_EVENTS || size > 8 * 1024 * 1024) {
          renameSync(file, `${file}.1`);
        }
      }
      appendFileSync(file, lines.join("\n") + "\n");
    } catch {
      // Projection failures must never break the caller; the next sync retries.
      return 0;
    }
    return fresh.length;
  }
}
