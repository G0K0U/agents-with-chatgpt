import type { DshNativeSummary } from "../../execution/dsh-native-client.js";
import { sameDshRoot, type DshBinding } from "../../execution/dsh-native-service.js";
import type { AgentSessionRecord } from "../types.js";
import type { AppendableActivityEvent } from "../store.js";

function sameExistingRoot(left: string, right: string): boolean {
  try { return sameDshRoot(left, right); } catch { return false; }
}

/** Cold DSH discovery projected into the shared read-only agent plane. */
export function projectDshDiscovery(input: {
  discovered: Array<{ workspaceId: string; canonicalPath: string; item: DshNativeSummary }>;
  bindings: DshBinding[];
  taskRecords: AgentSessionRecord[];
  observedAt: string;
}): { records: AgentSessionRecord[]; events: AppendableActivityEvent[] } {
  const tasks = new Map(input.taskRecords.filter((record) => record.provider === "dsh")
    .map((record) => [record.sessionId, record]));
  const bindings = new Map(input.bindings.map((binding) => [binding.sessionId, binding]));
  const records: AgentSessionRecord[] = [];
  const events: AppendableActivityEvent[] = [];
  for (const { workspaceId, canonicalPath, item } of input.discovered) {
    if (!item.sessionId || !item.cwd || !sameExistingRoot(item.cwd, canonicalPath)) continue;
    const candidate = bindings.get(item.sessionId);
    const binding = candidate && candidate.workspaceId === workspaceId
      && sameExistingRoot(candidate.canonicalRoot, canonicalPath) ? candidate : null;
    const task = tasks.get(item.sessionId);
    const origin = binding ? "a2c" : item.origin === "desktop" || item.origin === null ? "desktop" : "native";
    records.push({
      sessionId: item.sessionId, provider: "dsh", origin, workspaceId,
      canonicalRoot: canonicalPath, nativeSessionId: item.sessionId,
      providerSessionId: item.sessionId, ownerClientId: binding?.ownerId ?? null,
      controllers: binding ? [binding.ownerId] : [],
      model: task?.model ?? null, thoughtLevel: task?.thoughtLevel ?? null,
      status: item.running ? "running" : task?.status ?? (item.blank ? "blank" : "idle"),
      title: task?.title ?? null, createdAt: binding?.createdAt ?? item.updatedAt,
      updatedAt: item.updatedAt, taskIds: task?.taskIds ?? [],
      lastUserInstruction: task?.lastUserInstruction ?? null,
      lastAssistantOutput: task?.lastAssistantOutput ?? null,
      changedFilesCount: task?.changedFilesCount ?? 0,
      verificationStatus: null, observedAt: input.observedAt,
      live_read_status: "ok", messages_readable: null, last_live_error: null,
    });
    events.push({ key: `dsh:session:${item.sessionId}:discovered`,
      at: item.updatedAt, type: "session.discovered", provider: "dsh",
      workspaceId, sessionId: item.sessionId, taskId: null,
      summary: `dsh ${origin} session discovered` });
  }
  return { records, events };
}
