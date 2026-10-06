/**
 * One-shot verification of the user's historical pattern under the fixed
 * guard: explicit INDIVIDUAL plan + GLM-5.3-Flash/max, create -> attest ->
 * one minimal turn -> re-attest. Explicit plan = quota discipline honored.
 */
import { loadConfig } from "../config.js";
import { ZcodeOfficialProvider } from "../providers/zcode/official.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ws = { workspacePath: process.cwd(), workspaceKey: process.cwd() };
  const provider = new ZcodeOfficialProvider(cfg, {
    modelId: cfg.requestedModelId,
    thoughtLevel: cfg.requestedThoughtLevel,
    providerId: cfg.requestedProviderId,
  });
  try {
    await provider.start();
    const sessionId = await provider.createSession(ws, {
      readonly: true,
      entitlementPlan: "INDIVIDUAL",
      modelId: "GLM-5.3-Flash",
      thoughtLevel: "max",
    });
    const att = await provider.readSessionState(sessionId, ws);
    console.log(JSON.stringify({
      step: "create+attest",
      provider: att.providerId,
      model: att.modelId,
      thought: att.thoughtLevel,
      entitlement: att.entitlement,
    }, null, 1));
    const marker = await provider.snapshotAssistantMarker(sessionId);
    const handle = await provider.send({
      sessionId,
      instruction: "Reply with exactly: PLAN-CANARY-OK. Do not use tools or read files.",
      inputId: `z2c-individual-flash-${Date.now()}`,
      timeoutMs: 3 * 60_000,
      entitlementPlan: "INDIVIDUAL",
    });
    const turn = await handle.completion;
    const output = await provider.readAssistantOutput(sessionId, cfg.maxOutputChars, {
      minAssistantCount: marker,
      allowModelError: true,
    });
    const attAfter = await provider.readSessionState(sessionId, ws);
    console.log(JSON.stringify({
      step: "turn",
      turnStatus: turn.status,
      output: output.slice(0, 60),
      providerAfter: attAfter.providerId,
      modelAfter: attAfter.modelId,
      entitlementAfter: attAfter.entitlement,
    }, null, 1));
    await provider.stopSession(sessionId).catch(() => undefined);
    await provider.closeSession(sessionId).catch(() => undefined);
  } finally {
    await provider.stop().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
