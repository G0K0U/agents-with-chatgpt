/**
 * Entitlement-plan canaries: prove START / INDIVIDUAL / DEFAULT precise
 * selection end-to-end against the REAL installed ZCode agent, using the
 * standalone account runtime (the child resolves billing entitlements from
 * ZCode's own credential store; Z2C never touches credential material).
 *
 * Per plan (budget: ONE minimal turn per entitled plan; zero quota for
 * DEFAULT and for the exact-pair re-create):
 *   1. plan-only create → attest the registry readback (requested/observed
 *      plan) and RECORD the model/thought the runtime itself selected —
 *      each plan kind advertises its own model catalog, so the model is
 *      learned, never assumed.
 *   2. exact-pair re-create (plan + learned model + learned thought, no
 *      turn) → proves the pair is exactly selectable (no silent
 *      substitution), costs nothing.
 *   3. (entitled plans only) one minimal turn on the plan-only session →
 *      real output → re-attest. DEFAULT gets NO turn: its sessions may land
 *      on an entitled route and would consume that plan's quota — all real
 *      consumption in this canary happens under an EXPLICIT plan request.
 *
 * Fail-closed rules mirrored from the engine: a -32002 at create is reported
 * as plan-unavailable (credential-state evidence, exit 2), never as a crash;
 * no session silently falls back to another plan.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { ZcodeOfficialProvider } from "../providers/zcode/official.js";
import type { EntitlementPlan } from "../providers/entitlement.js";

const step = (n: string, msg: string): void => console.error(`[plan-canary] ${n}: ${msg}`);

function newWorkspace(tag: string): { path: string; ref: { workspacePath: string; workspaceKey: string } } {
  const path = join(process.cwd(), "test-workspace", `canary-plan-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(path, { recursive: true });
  return { path, ref: { workspacePath: path, workspaceKey: path } };
}

interface PlanVerdict {
  plan: EntitlementPlan;
  status: "pass" | "unavailable" | "fail";
  sessionId?: string;
  attestedProviderId?: string | null;
  attestedModelId?: string | null;
  attestedThoughtLevel?: string | null;
  entitlementReadback?: { requested: string | null; observed: string | null; access_mode: string | null; source: string };
  exactPairSession?: string;
  exactPairAttested?: boolean;
  turnStatus?: string;
  outputMatches?: boolean;
  reason?: string;
}

async function closeSession(provider: ZcodeOfficialProvider, sessionId: string): Promise<void> {
  await provider.stopSession(sessionId).catch(() => undefined);
  await provider.closeSession(sessionId).catch(() => undefined);
}

async function runPlan(
  provider: ZcodeOfficialProvider,
  cfg: ReturnType<typeof loadConfig>,
  plan: EntitlementPlan,
): Promise<PlanVerdict> {
  const ws = newWorkspace(plan.toLowerCase());
  const verdict: PlanVerdict = { plan, status: "fail" };
  let sessionId: string | undefined;
  let exactPairSession: string | undefined;
  try {
    step(plan, `creating plan-only session (entitlementPlan=${plan}) in ${ws.path}`);
    try {
      sessionId = await provider.createSession(ws.ref, {
        readonly: true,
        entitlementPlan: plan,
      });
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      if (/-32002|no entitled provider declares it/i.test(msg)) {
        return { ...verdict, status: "unavailable", reason: msg.slice(0, 200) };
      }
      if (/ENTITLEMENT_UNAVAILABLE/i.test(msg)) {
        return { ...verdict, status: "unavailable", reason: msg.slice(0, 200) };
      }
      return { ...verdict, reason: `create failed: ${msg.slice(0, 200)}` };
    }
    verdict.sessionId = sessionId;
    step(plan, `session ${sessionId}; attesting exact-session binding`);

    const att = await provider.readSessionState(sessionId, ws.ref);
    verdict.attestedProviderId = att.providerId;
    verdict.attestedModelId = att.modelId;
    verdict.attestedThoughtLevel = att.thoughtLevel;
    verdict.entitlementReadback = att.entitlement;

    if (plan === "DEFAULT") {
      // Semantic independence: DEFAULT never REQUESTS a plan. The runtime's
      // own default model may live on an entitled route (honest readback);
      // that is a routing-policy observation, not a plan substitution.
      if (att.entitlement?.requested != null) {
        return { ...verdict, reason: `DEFAULT session unexpectedly carries a REQUESTED plan ${att.entitlement.requested}` };
      }
      if (att.entitlement?.observed != null) {
        step(plan, `note: runtime default routes via observed plan ${att.entitlement.observed} (no turn sent — quota stays on the explicitly requested plan)`);
      }
      // DEFAULT: attestation-only. The runtime default's observed model IS the
      // catalog fact; no exact-pair re-create and no turn needed.
      verdict.status = "pass";
      return verdict;
    }

    // Non-DEFAULT needs registry-backed readback on this exact session.
    if (att.entitlement?.source !== "provider-registry" || att.entitlement.observed !== plan) {
      return {
        ...verdict,
        reason: `readback did not attest ${plan} (source=${att.entitlement?.source ?? "none"}, observed=${att.entitlement?.observed ?? "none"})`,
      };
    }
    if (!att.modelId || !att.thoughtLevel) {
      return { ...verdict, reason: "runtime did not attest a model/thought pair on the plan route" };
    }
    if (att.planEnabled !== true) {
      return { ...verdict, reason: `readonly lane lost plan evidence (planEnabled=${att.planEnabled})` };
    }

    // Exact-pair re-create: plan + the LEARNED model/thought pair must be
    // exactly selectable (no turn → no quota). A mismatch here means the
    // runtime's own catalog cannot re-offer what it selected — fail loudly.
    step(plan, `exact-pair re-create (plan + ${att.modelId}/${att.thoughtLevel}, no turn)`);
    try {
      exactPairSession = await provider.createSession(ws.ref, {
        readonly: true,
        entitlementPlan: plan,
        modelId: att.modelId,
        thoughtLevel: att.thoughtLevel,
      });
    } catch (err) {
      return { ...verdict, reason: `exact-pair create failed: ${String((err as Error)?.message ?? err).slice(0, 200)}` };
    }
    verdict.exactPairSession = exactPairSession;
    const attExact = await provider.readSessionState(exactPairSession, ws.ref);
    verdict.exactPairAttested =
      attExact.entitlement?.source === "provider-registry" &&
      attExact.entitlement.observed === plan &&
      attExact.modelId === att.modelId &&
      attExact.thoughtLevel === att.thoughtLevel;
    if (!verdict.exactPairAttested) {
      return { ...verdict, reason: `exact-pair session did not attest ${plan}/${att.modelId}/${att.thoughtLevel} exactly` };
    }
    await closeSession(provider, exactPairSession);
    exactPairSession = undefined;

    step(plan, "sending minimal turn (read-only reply probe, explicit plan)");
    const marker = await provider.snapshotAssistantMarker(sessionId);
    const handle = await provider.send({
      sessionId,
      instruction: "Reply with exactly: PLAN-CANARY-OK. Do not use tools or read files.",
      inputId: `z2c-plan-canary-${plan}-${Date.now()}`,
      timeoutMs: 3 * 60_000,
      entitlementPlan: plan,
    });
    const turn = await handle.completion;
    verdict.turnStatus = turn.status;
    if (turn.detail) step(plan, `turn detail: ${turn.detail}`);
    const output = await provider.readAssistantOutput(sessionId, cfg.maxOutputChars, {
      minAssistantCount: marker,
      allowModelError: true,
    });
    verdict.outputMatches = /PLAN-CANARY-OK/.test(output);
    step(plan, `turn=${turn.status} outputMatches=${verdict.outputMatches} output=${JSON.stringify(output.slice(0, 200))}`);

    // Re-attest AFTER the turn: the binding must survive the round trip.
    const attAfter = await provider.readSessionState(sessionId, ws.ref);
    if (attAfter.modelId !== att.modelId || attAfter.thoughtLevel !== att.thoughtLevel) {
      return { ...verdict, reason: "binding changed across the turn" };
    }
    if (attAfter.entitlement?.observed !== att.entitlement?.observed) {
      return { ...verdict, reason: "entitlement readback changed across the turn" };
    }
    if (!verdict.outputMatches) {
      return { ...verdict, reason: `turn output missing expected marker: ${output.slice(0, 120)}` };
    }
    verdict.status = "pass";
    return verdict;
  } catch (err) {
    return { ...verdict, reason: String((err as Error)?.message ?? err).slice(0, 240) };
  } finally {
    if (sessionId) await closeSession(provider, sessionId);
    if (exactPairSession) await closeSession(provider, exactPairSession);
    try { rmSync(ws.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* deferred */ }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  // The service main (src/service/main.ts) hardwires the official provider
  // regardless of Z2C_PROVIDER; the canary exercises that same lane directly,
  // so a legacy Z2C_PROVIDER value is a warning, not a blocker.
  if (cfg.providerMode !== "official") {
    step("warn", `Z2C_PROVIDER=${cfg.providerMode} is inert for the service lane; canary exercises official directly`);
  }
  if (!cfg.standaloneAccountRuntime) {
    throw new Error("standalone account runtime is NOT enabled (set Z2C_STANDALONE_ACCOUNT_RUNTIME=1); the canary would prove nothing beyond the old fail-closed behavior");
  }
  if (!existsSync(cfg.zcodeCliPath)) throw new Error(`ZCode CLI not found: ${cfg.zcodeCliPath}`);
  const provider = new ZcodeOfficialProvider(cfg, {
    modelId: cfg.requestedModelId,
    thoughtLevel: cfg.requestedThoughtLevel,
    providerId: cfg.requestedProviderId,
  });
  try {
    await provider.start();
    step("cap", `agent ${provider.providerVersion} capabilities=${JSON.stringify(provider.getRuntimeCapabilities())}`);
    const verdicts: PlanVerdict[] = [];
    for (const plan of ["START", "INDIVIDUAL", "DEFAULT"] as const) {
      verdicts.push(await runPlan(provider, cfg, plan));
    }
    console.log(JSON.stringify({ canary: "entitlement-plans", verdicts }, null, 2));
    const pass = verdicts.filter((v) => v.status === "pass").length;
    const unavailable = verdicts.filter((v) => v.status === "unavailable");
    if (pass === verdicts.length) {
      console.error("[plan-canary] PASS: START + INDIVIDUAL + DEFAULT proven end-to-end");
      return;
    }
    if (unavailable.length > 0 && pass + unavailable.length === verdicts.length) {
      console.error("[plan-canary] BLOCKED: plan(s) unavailable on this credential state (see verdicts); wiring itself did not crash");
      process.exitCode = 2;
      return;
    }
    console.error("[plan-canary] FAIL");
    process.exitCode = 1;
  } finally {
    await provider.stop().catch(() => undefined);
  }
}

main().catch((err) => {
  console.error("[plan-canary] FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
