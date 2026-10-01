/**
 * Read-only message-shape probe: create a session, send one minimal turn,
 * then dump the STRUCTURE of session/messages (roles, part types, text
 * lengths only — never message content) to diagnose output collection.
 */
import { loadConfig } from "../config.js";
import { ZcodeOfficialProvider } from "../providers/zcode/official.js";

function redactStructure(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m: Record<string, unknown>, i: number) => {
    const info = m.info as Record<string, unknown> | undefined;
    const parts = m.parts as Array<Record<string, unknown>> | undefined;
    return {
      index: i,
      topLevelKeys: Object.keys(m),
      infoKeys: info ? Object.keys(info) : null,
      role: info?.role,
      error: info?.error != null ? "PRESENT" : null,
      parts: (parts ?? []).map((p) => ({
        type: p.type,
        textLen: typeof p.text === "string" ? p.text.length : null,
        keys: Object.keys(p),
      })),
    };
  });
}

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
    const sessionId = await provider.createSession(ws, {});
    console.error(`[probe] session ${sessionId}`);
    const marker = await provider.snapshotAssistantMarker(sessionId);
    console.error(`[probe] assistant marker before send: ${marker}`);
    const handle = await provider.send({
      sessionId,
      instruction: "Reply with exactly: PLAN-CANARY-OK. Do not use tools or read files.",
      inputId: `z2c-shape-probe-${Date.now()}`,
      timeoutMs: 3 * 60_000,
    });
    const turn = await handle.completion;
    console.error(`[probe] turn: ${turn.status}${turn.detail ? ` (${turn.detail})` : ""}`);
    await new Promise((r) => setTimeout(r, 3000));
    // Reach into the protocol for the raw message list (provider-internal surface).
    const proto = (provider as unknown as { requireProtocol(): { request(m: string, p: unknown, t?: number): Promise<unknown> } }).requireProtocol();
    const res = (await proto.request("session/messages", { sessionId }, 20000)) as { messages?: unknown };
    console.log(JSON.stringify(redactStructure(res.messages), null, 1));
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
