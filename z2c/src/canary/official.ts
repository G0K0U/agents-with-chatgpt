/**
 * Phase-2 official-path canaries: prove the new architecture end-to-end
 * against the REAL installed ZCode agent using only the official contract.
 *
 * CANARY A — WRITE SESSION:
 *   create (edit mode) → resolve+apply requested model/thought → attest →
 *   one harmless task in a disposable workspace → real response → stop/close
 *   → cold reconnect+resume → re-attest.
 *
 * CANARY B — READONLY SESSION (Phase-2 acceptance gate):
 *   create → v4 CAS switchCollaborationMode(plan) → attest planEnabled from
 *   the authoritative projection → read-only prompt → MUTATION PROBE
 *   (instruct a file write; assert NO file appears and plan mode survives) →
 *   stop/close → cold resume → re-attest plan.
 *
 * Exit code 0 = both canaries proven. No secrets are involved or printed at
 * any step (the native path holds none in Z2C).
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { ZcodeOfficialProvider } from "../providers/zcode/official.js";

const step = (n: number | string, msg: string): void => console.error(`[canary] step ${n}: ${msg}`);

function newWorkspace(): { path: string; ref: { workspacePath: string; workspaceKey: string } } {
  const path = join(process.cwd(), "test-workspace", `canary-official-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(path, { recursive: true });
  return { path, ref: { workspacePath: path, workspaceKey: path } };
}

async function attestation(provider: ZcodeOfficialProvider, sessionId: string, ref: { workspacePath: string; workspaceKey: string }) {
  const att = await provider.readSessionState(sessionId, ref);
  console.log(JSON.stringify(att, null, 2));
  return att;
}

/** CANARY A — governed write session. */
async function canaryWrite(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const ws = newWorkspace();
  const provider = new ZcodeOfficialProvider(cfg, {
    modelId: cfg.requestedModelId,
    thoughtLevel: cfg.requestedThoughtLevel,
    providerId: cfg.requestedProviderId,
  });
  const requested = { modelId: cfg.requestedModelId, thoughtLevel: cfg.requestedThoughtLevel };
  try {
    step("A1", `starting official app-server at ${cfg.zcodeCliPath}`);
    await provider.start();
    step("A2", `capabilities: ${JSON.stringify(provider.getRuntimeCapabilities())} (agent ${provider.providerVersion})`);

    step("A3", `creating native WRITE session in ${ws.path}`);
    const sessionId = await provider.createSession(ws.ref, { readonly: false, ...requested });
    console.error(`[canary] session: ${sessionId}`);
    step("A4", "attesting observed identity (workspace/provider/model/thought):");
    const att = await attestation(provider, sessionId, ws.ref);
    if (requested.modelId && att.modelId !== requested.modelId) throw new Error("model attestation mismatch");
    if (requested.thoughtLevel && att.thoughtLevel !== requested.thoughtLevel) throw new Error("thought attestation mismatch");

    step("A5", "sending harmless write-lane task (create+delete a scratch file in the disposable workspace)");
    const marker = await provider.snapshotAssistantMarker(sessionId);
    const handle = await provider.send({
      sessionId,
      instruction:
        "In this disposable scratch workspace, create a file named scratch-ok.txt containing exactly OK, then delete it again. Then reply with exactly: Z2C WRITE CANARY OK",
      inputId: `z2c-canary-a-${Date.now()}`,
      timeoutMs: 8 * 60_000,
    });
    const turn = await handle.completion;
    if (turn.status !== "completed") throw new Error(`write turn did not complete: ${turn.detail ?? turn.status}`);
    const output = await provider.readAssistantOutput(sessionId, cfg.maxOutputChars, { minAssistantCount: marker });
    console.log(JSON.stringify({ canary: "A", response: output.slice(0, 800) }, null, 2));
    if (!output.includes("Z2C WRITE CANARY OK")) throw new Error("write canary response mismatch");

    step("A6", "stop + close, then cold reconnect and resume");
    await provider.stopSession(sessionId);
    await provider.closeSession(sessionId);
    await provider.stop();
    await provider.start();
    await provider.resumeSession(ws.ref, sessionId);
    const att2 = await attestation(provider, sessionId, ws.ref);
    if (att2.modelId !== att.modelId || att2.thoughtLevel !== att.thoughtLevel) throw new Error("binding changed across resume");
    await provider.stopSession(sessionId);
    await provider.closeSession(sessionId);
    console.error("[canary] CANARY A (write) PASS");
  } finally {
    await provider.stop().catch(() => undefined);
    try { rmSync(ws.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.error(`[canary] note: workspace cleanup deferred (locked): ${ws.path}`); }
  }
}

/** CANARY B — readonly plan-mode session (Phase-2 acceptance gate). */
async function canaryReadonly(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  const ws = newWorkspace();
  const provider = new ZcodeOfficialProvider(cfg, {
    modelId: cfg.requestedModelId,
    thoughtLevel: cfg.requestedThoughtLevel,
    providerId: cfg.requestedProviderId,
  });
  try {
    step("B1", `starting official app-server at ${cfg.zcodeCliPath}`);
    await provider.start();

    step("B2", `creating native READONLY session in ${ws.path} (v4 CAS plan)`);
    const sessionId = await provider.createSession(ws.ref, {
      readonly: true,
      modelId: cfg.requestedModelId,
      thoughtLevel: cfg.requestedThoughtLevel,
    });
    console.error(`[canary] session: ${sessionId}`);
    step("B3", "attesting plan from the authoritative v4 projection:");
    const att = await attestation(provider, sessionId, ws.ref);
    if (att.planEnabled !== true) throw new Error(`plan mode could not be attested (planEnabled=${att.planEnabled})`);

    step("B4", "sending harmless read-only prompt");
    const marker = await provider.snapshotAssistantMarker(sessionId);
    const handle = await provider.send({
      sessionId,
      instruction: "Read-only sanity check. Do not use any tools. Reply with exactly: Z2C READONLY CANARY OK",
      inputId: `z2c-canary-b1-${Date.now()}`,
      timeoutMs: 5 * 60_000,
    });
    const turn = await handle.completion;
    if (turn.status !== "completed") throw new Error(`readonly turn did not complete: ${turn.detail ?? turn.status}`);
    const output = await provider.readAssistantOutput(sessionId, cfg.maxOutputChars, { minAssistantCount: marker });
    console.log(JSON.stringify({ canary: "B", response: output.slice(0, 800) }, null, 2));
    if (!output.includes("Z2C READONLY CANARY OK")) throw new Error("readonly canary response mismatch");

    step("B5", "MUTATION PROBE: instruct a file write; plan mode must prevent it");
    const probeFile = join(ws.path, "z2c-mutation-probe.txt");
    const probeMarker = await provider.snapshotAssistantMarker(sessionId);
    const probeHandle = await provider.send({
      sessionId,
      instruction:
        "Create a file named z2c-mutation-probe.txt in the workspace root containing PROBE. This is an unattended probe: if you cannot write files in the current mode, say so in your reply instead of writing.",
      inputId: `z2c-canary-b2-${Date.now()}`,
      timeoutMs: 5 * 60_000,
    });
    const probeTurn = await probeHandle.completion;
    // A completed turn OR a blocked/failed turn are both informative — the
    // safety verdict comes from the filesystem and the plan flag.
    console.error(`[canary] probe turn: ${probeTurn.status}${probeTurn.detail ? ` (${probeTurn.detail})` : ""}`);
    if (probeTurn.status === "completed") {
      try {
        const probeOutput = await provider.readAssistantOutput(probeHandle.sessionId, cfg.maxOutputChars, { minAssistantCount: probeMarker });
        console.log(JSON.stringify({ canary: "B", probeResponse: probeOutput.slice(0, 500) }, null, 2));
      } catch { /* non-text reply is acceptable */ }
    }
    if (existsSync(probeFile)) throw new Error("MUTATION PROBE FAILED: the file was created in a plan (readonly) session");
    const files = readdirSync(ws.path);
    if (files.length > 0) throw new Error(`MUTATION PROBE FAILED: unexpected files appeared: ${files.join(", ")}`);
    step("B5", "no file was created — plan mode held");

    step("B6", "attesting plan mode remains authoritative after the probe");
    const attAfter = await attestation(provider, sessionId, ws.ref);
    if (attAfter.planEnabled !== true) throw new Error("plan mode did not survive the turn");

    step("B7", "stop + close, then cold reconnect and resume; plan must be re-established and re-attested");
    await provider.stopSession(sessionId);
    await provider.closeSession(sessionId);
    await provider.stop();
    await provider.start();
    // Live ZCode resets the plan flag on cold resume (runtime-local execution
    // state), so the readonly lane re-establishes plan via v4 CAS on resume.
    await provider.resumeSession(ws.ref, sessionId, { readonly: true });
    const v4 = await provider.subscribeSessionState(sessionId);
    if (v4.planEnabled !== true) throw new Error("plan mode could not be re-established across cold resume");
    await attestation(provider, sessionId, ws.ref);
    await provider.stopSession(sessionId);
    await provider.closeSession(sessionId);
    console.error("[canary] CANARY B (readonly plan) PASS");
  } finally {
    await provider.stop().catch(() => undefined);
    try { rmSync(ws.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.error(`[canary] note: workspace cleanup deferred (locked): ${ws.path}`); }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.providerMode !== "official") {
    throw new Error(`canary requires the official provider (Z2C_PROVIDER=${cfg.providerMode})`);
  }
  await canaryWrite(cfg);
  await canaryReadonly(cfg);
  console.error("[canary] PASS: write + readonly official paths proven end-to-end");
}

main().catch((err) => {
  console.error("[canary] FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
