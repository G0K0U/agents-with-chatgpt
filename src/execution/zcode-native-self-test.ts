import { randomUUID } from "node:crypto";
import { assertNativeIdempotency, nativeRequestFingerprint, ZcodeNativeError,
  ZCODE_IDEMPOTENCY_PROTOCOL, ZCODE_NATIVE_REQUIRED_IDENTITY, type ZcodeNativeClient, type ZcodeNativeTaskView } from "./zcode-native.js";

const PROBE = "Read-only protocol probe. Do not use tools, read files, run commands, or change anything. Reply only: C2C native protocol probe.";
type Snapshot = { queue: string; writer: string };
export type LayerResult = "PASS" | "FAIL" | "NOT_RUN";
export interface NativeSelfTestDeps {
  providerStatus: ZcodeNativeClient["providerStatus"];
  submitNative: (input: Parameters<ZcodeNativeClient["submitTask"]>[0]) => Promise<ZcodeNativeTaskView>;
  snapshot: () => Snapshot;
  cancel?: (input: { workspace_id: string; task_id: string }) => Promise<ZcodeNativeTaskView>;
  /** Optional layered proof: read the admitted task back from Z2C. */
  getTask?: (input: { workspace_id: string; task_id: string }) => Promise<ZcodeNativeTaskView>;
  /** Optional layered proof: attest the exact native session in place. */
  readSession?: (input: { workspace_id: string; session_id: string }) => Promise<unknown>;
}

export interface NativeSelfTestEvidence {
  protocol: string | null;
  layers: {
    transport: LayerResult;
    service_protocol: LayerResult;
    workspace_binding: LayerResult;
    desktop_managed_auth: LayerResult;
    provider_identity: LayerResult;
    model_identity: LayerResult;
    submit_admission: LayerResult;
    idempotent_replay: LayerResult;
    idempotency_conflict: LayerResult;
    task_read_back: LayerResult;
    session_attestation: LayerResult;
    queue_writer_invariants: LayerResult;
    cancel_cleanup: LayerResult;
  };
  identity: { workspace_id: string; task_id: string; session_id: string } | null;
  model_binding: { provider_id: string; model_id: string } | null;
  fingerprint_hashes: { original: string; changed: string };
  replay_flags: boolean[];
  conflict_code: string | null;
  invariants: { queue_unchanged: boolean; writer_unchanged: boolean };
  cleanup: "not_created" | "unknown_admission" | "not_authorized" | "cancelled" | "already_terminal" | "failed";
  overall: "PASS" | "FAIL";
}

/** Server-owned instructions and key; never project upstream strings or errors. */
export async function nativeSelfTest(workspaceId: string, deps: NativeSelfTestDeps) {
  const input = { workspace_id: workspaceId, instruction: PROBE, write_scope: "readonly" as const,
    mode: "plan" as const, idempotency_key: `c2c_selftest_${randomUUID()}` };
  const changed = { ...input, instruction: `${PROBE} This is the conflict check.` };
  const layers = {
    transport: "FAIL" as LayerResult,
    service_protocol: "FAIL" as LayerResult,
    workspace_binding: "FAIL" as LayerResult,
    desktop_managed_auth: "FAIL" as LayerResult,
    provider_identity: "FAIL" as LayerResult,
    model_identity: "FAIL" as LayerResult,
    submit_admission: "FAIL" as LayerResult,
    idempotent_replay: "FAIL" as LayerResult,
    idempotency_conflict: "FAIL" as LayerResult,
    task_read_back: (deps.getTask ? "FAIL" : "NOT_RUN") as LayerResult,
    session_attestation: (deps.readSession ? "FAIL" : "NOT_RUN") as LayerResult,
    queue_writer_invariants: "FAIL" as LayerResult,
    cancel_cleanup: "FAIL" as LayerResult,
  };
  const evidence = {
    protocol: null as string | null,
    layers,
    identity: null as { workspace_id: string; task_id: string; session_id: string } | null,
    model_binding: null as { provider_id: string; model_id: string } | null,
    fingerprint_hashes: { original: nativeRequestFingerprint(input), changed: nativeRequestFingerprint(changed) },
    replay_flags: [] as boolean[], conflict_code: null as string | null,
    invariants: { queue_unchanged: false, writer_unchanged: false },
    cleanup: "not_created" as "not_created" | "unknown_admission" | "not_authorized" | "cancelled" | "already_terminal" | "failed",
    overall: "FAIL" as "PASS" | "FAIL",
  };
  let original: ZcodeNativeTaskView | undefined;
  let before: Snapshot | undefined;
  let protocolPassed = false;
  let invariantsHeld = true;
  let queueUnchanged = true, writerUnchanged = true;
  const validSnapshot = (value: Snapshot) => /^[a-f0-9]{64}$/.test(value.queue) && /^[a-f0-9]{64}$/.test(value.writer);
  const checkSnapshot = () => {
    const after = deps.snapshot();
    queueUnchanged &&= !!before && validSnapshot(before) && validSnapshot(after) && before.queue === after.queue;
    writerUnchanged &&= !!before && validSnapshot(before) && validSnapshot(after) && before.writer === after.writer;
    evidence.invariants = { queue_unchanged: queueUnchanged, writer_unchanged: writerUnchanged };
    invariantsHeld &&= evidence.invariants.queue_unchanged && evidence.invariants.writer_unchanged;
  };
  const verify = (task: ZcodeNativeTaskView) => {
    if (task.workspace_id !== workspaceId || !/^z2c_[A-Za-z0-9_-]{1,100}$/.test(task.task_id) ||
        !task.session_id || !/^sess_[0-9a-f-]{36}$/i.test(task.session_id) ||
        task.model_binding?.provider_id !== ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id ||
        task.model_binding.model_id !== ZCODE_NATIVE_REQUIRED_IDENTITY.model_id) {
      throw new Error("invalid proof");
    }
    assertNativeIdempotency(task, input);
  };
  try {
    const status = await deps.providerStatus(workspaceId);
    layers.transport = "PASS";
    layers.workspace_binding = status?.workspace_id === workspaceId ? "PASS" : "FAIL";
    layers.desktop_managed_auth =
      (typeof status?.provider === "string" ? status.provider : "") === ZCODE_NATIVE_REQUIRED_IDENTITY.provider ? "PASS" : "FAIL";
    if (status?.workspace_id !== workspaceId || status.durable_idempotency !== ZCODE_IDEMPOTENCY_PROTOCOL) return evidence;
    layers.service_protocol = "PASS";
    evidence.protocol = ZCODE_IDEMPOTENCY_PROTOCOL;
    before = deps.snapshot();
    if (!validSnapshot(before)) throw new Error("Snapshot unavailable");
    evidence.cleanup = "unknown_admission";
    original = await deps.submitNative(input);
    verify(original);
    layers.submit_admission = "PASS";
    layers.provider_identity =
      original.model_binding?.provider_id === ZCODE_NATIVE_REQUIRED_IDENTITY.provider_id ? "PASS" : "FAIL";
    layers.model_identity =
      original.model_binding?.model_id === ZCODE_NATIVE_REQUIRED_IDENTITY.model_id ? "PASS" : "FAIL";
    evidence.identity = { workspace_id: original.workspace_id, task_id: original.task_id, session_id: original.session_id! };
    evidence.model_binding = { provider_id: original.model_binding!.provider_id, model_id: original.model_binding!.model_id };
    evidence.replay_flags.push(original.idempotency!.replayed);
    checkSnapshot();
    if (original.idempotency!.replayed !== false) throw new Error("first admission replayed");
    const replay = await deps.submitNative({ ...input });
    verify(replay);
    evidence.replay_flags.push(replay.idempotency!.replayed);
    checkSnapshot();
    if (replay.task_id !== original.task_id || replay.session_id !== original.session_id ||
        replay.idempotency!.request_fingerprint !== original.idempotency!.request_fingerprint || replay.idempotency!.replayed !== true) {
      throw new Error("replay identity mismatch");
    }
    layers.idempotent_replay = "PASS";
    try {
      await deps.submitNative(changed);
      // Any accepted response is a failure, even if it reuses the first identity.
    } catch (error) {
      if (error instanceof ZcodeNativeError && error.code === "ZCODE_NATIVE_UPSTREAM" && error.upstreamCode === "IDEMPOTENCY_CONFLICT") {
        evidence.conflict_code = "IDEMPOTENCY_CONFLICT";
        layers.idempotency_conflict = "PASS";
        protocolPassed = true;
      }
    }
    checkSnapshot();
    if (deps.getTask && evidence.identity) {
      const readBack = await deps.getTask({ workspace_id: workspaceId, task_id: original.task_id });
      layers.task_read_back =
        readBack.task_id === original.task_id && readBack.workspace_id === workspaceId &&
        readBack.session_id === original.session_id && readBack.status !== "unknown" ? "PASS" : "FAIL";
    }
    if (deps.readSession && evidence.identity) {
      await deps.readSession({ workspace_id: workspaceId, session_id: original.session_id! });
      layers.session_attestation = "PASS";
    }
  } catch {
    protocolPassed = false;
    // Do not release raw errors, headers, instructions, or authentication data.
  } finally {
    if (original && evidence.identity) {
      evidence.cleanup = "not_authorized";
      if (deps.cancel) {
        try {
          const result = await deps.cancel({ workspace_id: workspaceId, task_id: original.task_id });
          if (result.workspace_id !== workspaceId || result.task_id !== original.task_id || result.session_id !== original.session_id) throw new Error("cleanup identity mismatch");
          evidence.cleanup = result.status === "cancelled" ? "cancelled" :
            ["completed", "failed", "interrupted"].includes(result.status) ? "already_terminal" : "failed";
        } catch { evidence.cleanup = "failed"; }
      }
    } else if (original) evidence.cleanup = "failed";
    evidence.layers.cancel_cleanup =
      evidence.cleanup === "cancelled" || evidence.cleanup === "already_terminal" || evidence.cleanup === "not_authorized"
        ? "PASS" : "FAIL";
    if (before) {
      try { checkSnapshot(); } catch { invariantsHeld = false; evidence.invariants = { queue_unchanged: false, writer_unchanged: false }; }
    }
    evidence.layers.queue_writer_invariants =
      evidence.invariants.queue_unchanged && evidence.invariants.writer_unchanged ? "PASS" : "FAIL";
    const optionalLayersPass =
      (deps.getTask ? evidence.layers.task_read_back === "PASS" : true) &&
      (deps.readSession ? evidence.layers.session_attestation === "PASS" : true);
    evidence.overall = protocolPassed && invariantsHeld && optionalLayersPass ? "PASS" : "FAIL";
  }
  return evidence;
}
