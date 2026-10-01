import { saveJsonAtomic, loadJson } from "../../util/fsjson.js";
import { join } from "node:path";
import type { TaskRecord, TaskStatus } from "./model.js";
import type { WorkspaceEntry } from "../workspaces/registry.js";
import type { AgentProvider } from "../../providers/types.js";

export interface QueueState {
  paused: boolean;
  activeTask: string | null;
  queuedTaskIds: string[];
}

export interface Z2cState {
  version: 1;
  workspaces: WorkspaceEntry[];
  tasks: TaskRecord[];
  queues: Record<string, QueueState>;
  outputs: Array<{ outputId: string; taskId: string; workspaceId: string; sessionId: string | null; text: string; createdAt: number }>;
}

export class Persistence {
  private readonly path: string;
  private state: Z2cState;
  private persistenceFailed = false;

  constructor(stateDir: string) {
    this.path = join(stateDir, "state.json");
    const loaded = loadJson<Z2cState>(this.path);
    if (loaded && loaded.version !== 1) throw new Error("Unsupported durable task state version; refusing to forget idempotency bindings");
    this.state = loaded?.version === 1 ? loaded : { version: 1, workspaces: [], tasks: [], queues: {}, outputs: [] };
  }

  get data(): Z2cState {
    return this.state;
  }

  save(): void {
    this.assertHealthy();
    try { saveJsonAtomic(this.path, this.state); }
    catch (error) { this.persistenceFailed = true; throw error; }
  }

  assertHealthy(): void {
    if (this.persistenceFailed) throw new Error("PERSISTENCE_UNAVAILABLE: restart and reconcile durable state before dispatch");
  }

  /** Task, key binding and FIFO membership become durable in one replacement. */
  admitTask(task: TaskRecord): void {
    this.assertHealthy();
    const previous = this.state;
    const queue = this.getOrCreateQueue(task.workspaceId);
    this.state = { ...previous, tasks: [...previous.tasks], queues: { ...previous.queues,
      [task.workspaceId]: { ...queue, queuedTaskIds: [...queue.queuedTaskIds] } } };
    this.state.tasks.push(task);
    const oldOrdinary = this.state.tasks.filter(t => !t.idempotency && ["completed", "failed", "cancelled", "interrupted"].includes(t.status));
    const evict = new Set(oldOrdinary.slice(0, Math.max(0, this.state.tasks.filter(t => !t.idempotency).length - 500)).map(t => t.taskId));
    this.state.tasks = this.state.tasks.filter(t => !evict.has(t.taskId));
    this.getOrCreateQueue(task.workspaceId).queuedTaskIds.push(task.taskId);
    try { this.save(); }
    catch (error) { this.state = previous; this.persistenceFailed = true; throw error; }
  }

  /**
   * Restart reconciliation: tasks that were mid-flight when the bridge died
   * are marked `interrupted` (not completed, not failed) — historical truth
   * is preserved and never overwritten by optimistic assumptions.
   */
  reconcileOnRestart(): string[] {
    const touched: string[] = [];
    for (const t of this.state.tasks) {
      if (t.status === "running") {
        t.status = "interrupted";
        t.completedAt = Date.now();
        t.exitStatus = "interrupted: bridge restarted mid-run";
        touched.push(t.taskId);
      }
    }
    for (const [workspaceId, q] of Object.entries(this.state.queues)) {
      // A crash after reserving the queue head but before persisting running
      // has sent nothing. Rebuild its FIFO membership from durable task truth.
      const pending = this.state.tasks.filter(t => t.workspaceId === workspaceId && t.status === "queued").sort((a, b) => a.createdAt - b.createdAt);
      q.queuedTaskIds = [...new Set([...(q.activeTask ? [q.activeTask] : []), ...q.queuedTaskIds, ...pending.map(t => t.taskId)])]
        .filter(id => !this.findTask(id) || this.findTask(id)!.status === "queued");
      q.activeTask = null;
    }
    this.save();
    return touched;
  }

  upsertTask(t: TaskRecord): void {
    const i = this.state.tasks.findIndex((x) => x.taskId === t.taskId);
    if (i >= 0) this.state.tasks[i] = t;
    else this.state.tasks.push(t);
    // Keyed truth must never be evicted: forgetting a key permits duplicate work.
    const ordinary = this.state.tasks.filter(x => !x.idempotency);
    const evict = new Set(ordinary.slice(0, Math.max(0, ordinary.length - 500)).map(x => x.taskId));
    this.state.tasks = this.state.tasks.filter(x => !evict.has(x.taskId));
    this.save();
  }

  findTask(taskId: string): TaskRecord | undefined {
    return this.state.tasks.find((t) => t.taskId === taskId);
  }

  setStatus(taskId: string, status: TaskStatus, exitStatus?: string): TaskRecord {
    const t = this.findTask(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    t.status = status;
    if (status === "running" && !t.startedAt) t.startedAt = Date.now();
    if (["completed", "failed", "cancelled", "interrupted"].includes(status)) {
      t.completedAt = Date.now();
      if (exitStatus) t.exitStatus = exitStatus;
    }
    this.save();
    return t;
  }

  /**
   * Persist an output reference on an already-terminal (or terminal-bound)
   * task without touching status/completion fields — used by the failure
   * path that saves partial checkpoint output.
   */
  attachOutput(taskId: string, outputId: string): void {
    const t = this.findTask(taskId);
    if (!t) throw new Error(`task not found: ${taskId}`);
    t.outputId = outputId;
    this.save();
  }

  getOrCreateQueue(workspaceId: string): QueueState {
    let q = this.state.queues[workspaceId];
    if (!q) {
      q = { paused: false, activeTask: null, queuedTaskIds: [] };
      this.state.queues[workspaceId] = q;
    }
    return q;
  }

  saveQueue(workspaceId: string, q: QueueState): void {
    this.state.queues[workspaceId] = q;
    this.save();
  }

  saveOutput(entry: Z2cState["outputs"][number]): void {
    this.state.outputs.push(entry);
    if (this.state.outputs.length > 200) this.state.outputs.splice(0, this.state.outputs.length - 200);
    this.save();
  }
}
