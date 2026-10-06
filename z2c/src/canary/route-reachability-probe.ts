/**
 * Route-reachability probe (2026-10-01): after the standalone account runtime
 * admitted account routes, verify how GLM-5.3-Flash can be reached for the
 * historical DEFAULT flow. Read-only attestations; one disposable session per
 * step; no turns dispatched (zero model quota).
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

    console.error("[probe-1] DEFAULT create (no model) — where does the runtime default land?");
    const s1 = await provider.createSession(ws, {});
    const a1 = await provider.readSessionState(s1, ws);
    console.log(JSON.stringify({ step: 1, provider: a1.providerId, model: a1.modelId, thought: a1.thoughtLevel }));

    console.error("[probe-2] bare-model setModel GLM-5.3-Flash from the default session");
    try {
      await provider.updateSessionModel(ws, s1, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      const a2 = await provider.readSessionState(s1, ws);
      console.log(JSON.stringify({ step: 2, ok: true, provider: a2.providerId, model: a2.modelId, thought: a2.thoughtLevel }));
    } catch (err) {
      console.log(JSON.stringify({ step: 2, ok: false, error: String((err as Error)?.message ?? err).slice(0, 180) }));
    }

    console.error("[probe-3] skipped: cross-provider setModel is not a Z2C surface (same-session updates are provider-locked by type)");

    console.error("[probe-4] DEFAULT create with explicit modelId=GLM-5.3-Flash (historical engine pattern)");
    try {
      const s4 = await provider.createSession(ws, { modelId: "GLM-5.3-Flash", thoughtLevel: "max" });
      const a4 = await provider.readSessionState(s4, ws);
      console.log(JSON.stringify({ step: 4, ok: true, provider: a4.providerId, model: a4.modelId, thought: a4.thoughtLevel }));
      await provider.stopSession(s4).catch(() => undefined);
      await provider.closeSession(s4).catch(() => undefined);
    } catch (err) {
      console.log(JSON.stringify({ step: 4, ok: false, error: String((err as Error)?.message ?? err).slice(0, 180) }));
    }
  } finally {
    await provider.stop().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
