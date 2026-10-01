/**
 * Read-only probe of the live standalone runtime's model surface:
 * capabilities + the session's own settings (model availability, reasoning
 * evidence, entitlement readback). No turns are dispatched; one disposable
 * DEFAULT session is created and immediately closed.
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
    console.error(`[probe] agent ${provider.providerVersion} capabilities=${JSON.stringify(provider.getRuntimeCapabilities())}`);
    // PROBE_ENTITLEMENT=start-plan|individual-coding-plan exercises the
    // entitlement-constrained create path; unset = plain DEFAULT create.
    const entitlement = process.env.PROBE_ENTITLEMENT?.trim() || undefined;
    const sessionId = await provider.createSession(ws, {
      ...(entitlement ? { entitlementPlan: entitlement === "individual-coding-plan" ? "INDIVIDUAL" : "START" } : {}),
    });
    const settings = await provider.observeSessionSettings(sessionId);
    console.log(JSON.stringify(settings, null, 1));
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
