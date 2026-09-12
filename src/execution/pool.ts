import { CodexTaskManager, type TaskManagerOptions } from "./tasks.js";
import { TaskError } from "./tasks.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { C2CSessionRegistry } from "../session/registry.js";
import { ContinuationController } from "./continuation.js";
import { collectContinuationAudit } from "./continuation-collector.js";

export interface TaskManagerPoolOptions extends Omit<TaskManagerOptions, "restartRequiredResolver" | "protectedWriteScopes"> {
  bridgeWorkspaceId?: string;
  taskManagerOptions?: Pick<TaskManagerOptions, "restartRequiredResolver" | "protectedWriteScopes">;
}

export interface TaskManagerMatch {
  workspaceId: string;
  manager: CodexTaskManager;
}

/** Lazily creates one isolated Codex/App Server lifecycle per registered workspace. */
export class CodexTaskManagerPool {
  private readonly managers = new Map<string, CodexTaskManager>();
  private closing = false;

  constructor(
    private readonly registry: WorkspaceRegistry,
    private readonly sessionRegistry: C2CSessionRegistry,
    private readonly opts: TaskManagerPoolOptions = {}
  ) {}

  get(workspaceId: string): CodexTaskManager {
    if (this.closing) throw new TaskError("CODEX_UNAVAILABLE", "The C2C bridge is shutting down");
    const existing = this.managers.get(workspaceId);
    if (existing) return existing;
    const workspace = this.registry.getWorkspace(workspaceId);
    const bridgeWorkspace = workspaceId === this.opts.bridgeWorkspaceId;
    const taskManagerOptions: TaskManagerOptions = {
      logger: this.opts.logger,
      stateDir: this.opts.stateDir,
      appServerFactory: this.opts.appServerFactory,
      orchestrator: this.opts.orchestrator,
      antigravityBackend: this.opts.antigravityBackend,
      omnigentBackend: this.opts.omnigentBackend,
      omnigent: this.opts.omnigent,
      verificationProfileResolver: this.opts.verificationProfileResolver,
      approvalEvaluator: this.opts.approvalEvaluator,
      taskTimeoutMs: this.opts.taskTimeoutMs,
      verificationTimeoutMs: this.opts.verificationTimeoutMs,
      approvalTimeoutMs: this.opts.approvalTimeoutMs,
      interruptGraceMs: this.opts.interruptGraceMs,
      fullAccess: this.opts.fullAccess,
      maxQueueSize: this.opts.maxQueueSize,
      nativeClient: this.opts.nativeClient,
      queueSize: this.opts.queueSize,
      queueLimit: this.opts.queueLimit,
      sessionRegistry: this.sessionRegistry,
      continuationAuthorize: this.opts.continuationAuthorize,
      onTaskLifecycleEvent: this.opts.onTaskLifecycleEvent,
      restartRequiredResolver:
        this.opts.taskManagerOptions?.restartRequiredResolver ??
        (bridgeWorkspace
          ? (changedFiles) => changedFiles.some((file) => /^(?:src|package\.json|pnpm-lock\.yaml|tsconfig\.json)(?:\/|$)/i.test(file))
          : undefined),
      protectedWriteScopes:
        this.opts.taskManagerOptions?.protectedWriteScopes ??
        (bridgeWorkspace ? ["dist", "bin", "node_modules", ".git"] : undefined),
    };
    const manager = new CodexTaskManager(workspace, taskManagerOptions);
    this.managers.set(workspaceId, manager);
    const authorize = this.opts.continuationAuthorize ?? (() => false);
    manager.continuationController = new ContinuationController(manager, {
      authorize,
      collect: (manifest, snapshot, eventId) => collectContinuationAudit(workspace, manager.stateDir, manifest, snapshot, eventId, authorize),
    });
    manager.continuationController.start();
    return manager;
  }

  has(workspaceId: string): boolean {
    return this.managers.has(workspaceId);
  }

  reloadContinuation(workspaceId: string): ContinuationController {
    const manager = this.get(workspaceId);
    if (manager.getQueueState().activeTask) throw new Error("Continuation activation requires an idle workspace");
    manager.continuationController?.close();
    const authorize = this.opts.continuationAuthorize ?? (() => false);
    const controller = new ContinuationController(manager, { authorize,
      collect: (manifest, snapshot, eventId) => collectContinuationAudit(manager.workspace, manager.stateDir, manifest, snapshot, eventId, authorize) });
    manager.continuationController = controller;
    controller.start();
    return controller;
  }

  /**
   * Locate a task only within the caller's already-authorized workspace set.
   * Task ids are the immutable cross-workspace lookup key; a numeric/local
   * queue or session id is never substituted for one.
   */
  findTaskManagers(taskId: string, workspaceIds: Iterable<string>): TaskManagerMatch[] {
    const matches: TaskManagerMatch[] = [];
    for (const workspaceId of new Set(workspaceIds)) {
      const manager = this.get(workspaceId);
      if (manager.hasTask(taskId)) matches.push({ workspaceId, manager });
    }
    return matches;
  }

  async close(): Promise<void> {
    this.closing = true;
    const managers = [...this.managers.values()];
    this.managers.clear();
    await Promise.all(managers.map((manager) => manager.close()));
  }
}
