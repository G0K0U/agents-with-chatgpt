#!/usr/bin/env node
// Isolated candidate bridge smoke. No public tunnel or model call.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { probeAuthenticatedMcp } from "./oauth-readonly-probe.mjs";

const [entryArg, evidenceArg, releaseId] = process.argv.slice(2);
if (!entryArg || !evidenceArg || !/^[A-Za-z0-9._-]+$/.test(releaseId ?? "")) {
  throw new Error("usage: candidate-smoke.mjs <candidate-cli> <evidence-dir> <release-id>");
}
const entry = realpathSync(entryArg);
const evidence = realpathSync(evidenceArg);
if (!entry.replaceAll("\\", "/").endsWith(`/releases/${releaseId}/cli/index.js`)) {
  throw new Error("candidate entry must belong to the named immutable release");
}
const releaseRoot = path.dirname(path.dirname(entry));
const manifestPath = path.join(releaseRoot, "build-manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { computeTreeHash } = await import(pathToFileURL(path.join(releaseRoot, "bridge", "runtime-identity.js")).href);
if (computeTreeHash(releaseRoot) !== manifest.buildHash) throw new Error("candidate build tree differs from its manifest");
const { ModelCatalogService, resolveModelSelection } = await import(pathToFileURL(path.join(releaseRoot, "execution", "model-catalog.js")).href);
const smokeRoot = path.join(evidence, `smoke-${randomUUID()}`);
mkdirSync(smokeRoot);
const workspace = path.join(smokeRoot, "workspace");
const stateDir = path.join(smokeRoot, "state");
const homeDir = path.join(smokeRoot, "home");
const tempDir = path.join(smokeRoot, "temp");
mkdirSync(workspace);
mkdirSync(stateDir);
mkdirSync(homeDir);
mkdirSync(tempDir);

// Exercise the compiled mapper and rejection paths. Import success or token
// normalization alone cannot prove that error payloads are sanitized.
const shortForms = [
  ["X-API-Key: SYNTHETIC_KEY_123", "SYNTHETIC_KEY_123"],
  ["Cookie: sid=SYNTHETIC_COOKIE_123", "SYNTHETIC_COOKIE_123"],
  ["Authorization: Basic U1lOVEhFVElDX09OTFk=", "U1lOVEhFVElDX09OTFk="],
  ["client_secret=SYNTHETIC_ONLY", "SYNTHETIC_ONLY"],
  ["Basic U1lOVEhFVElDX09OTFk=", "U1lOVEhFVElDX09OTFk="],
  ["x-api-key SYNTHETIC_KEY_123", "SYNTHETIC_KEY_123"],
  ['{"client_secret":"SYNTHETIC_ONLY"}', "SYNTHETIC_ONLY"],
];
for (const [dirty, forbidden] of shortForms) {
  const mapped = await new ModelCatalogService({
    workspaceRoot: workspace,
    zcodeModelCatalog: async () => ({ provider_status: "healthy", evidence_source: "all-candidates-unreadable",
      attempts: [{ session_id: "synthetic", outcome: "permission", error: dirty }] }),
  }).get(["zcode"]);
  const mappedError = mapped.agents[0].observation?.attempts?.[0]?.error ?? "";
  if (!mappedError || mappedError.includes(forbidden)) throw new Error("compiled catalog mapper leaked a synthetic credential");
  const rejected = await new ModelCatalogService({
    workspaceRoot: workspace,
    zcodeModelCatalog: async () => { throw new Error(dirty); },
  }).get(["zcode"]);
  const rejectionError = rejected.agents[0].error ?? "";
  if (!rejectionError || rejectionError.includes(forbidden)) throw new Error("compiled catalog rejection leaked a synthetic credential");
}
const model = (id) => ({ agent: "codex", provider_id: null, provider_label: null,
  model_id: id, display_name: "GPT-6", supported_efforts: [{ effort: "max", description: null }],
  default_effort: "max", is_default: false, input_modalities: ["text"], service_tiers: [],
  hidden: false, deprecation: null, evidence_source: "synthetic", observed_at: new Date().toISOString() });
const nowIso = new Date().toISOString();
const ambiguous = resolveModelSelection({ schema_version: 1, catalog_revision: "synthetic",
  fetched_at: nowIso, served_at: nowIso, expires_at: nowIso, freshness: "fresh",
  agents: [{ agent: "codex", source: "synthetic", runtime_version: null, auth_mode: null,
    completeness: "complete", error: null, observed_at: nowIso,
    models: [model("gpt-6-astra"), model("gpt-6-sol")] }] }, { agent: "codex", model: "GPT-6" });
if (ambiguous.status !== "ambiguous" || ambiguous.candidates.length !== 2) {
  throw new Error("compiled resolver did not prove the ambiguous branch");
}

const port = await new Promise((resolve, reject) => {
  const reservation = net.createServer();
  reservation.once("error", reject);
  reservation.listen(0, "127.0.0.1", () => {
    const address = reservation.address();
    reservation.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const env = {
  ...process.env,
  A2C_STATE_DIR: stateDir,
  C2C_STATE_DIR: stateDir,
  HOME: homeDir,
  USERPROFILE: homeDir,
  CODEX_HOME: path.join(homeDir, ".codex"),
  APPDATA: path.join(homeDir, "AppData", "Roaming"),
  LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
  TEMP: tempDir,
  TMP: tempDir,
  C2C_ZCODE_QUEUE_ROOT: "",
  C2C_ZCODE_COORDINATOR_DISABLE: "1",
  A2C_FULL_ACCESS_DEVELOPMENT: "0",
  ZCODE_AGENT_SERVER_COMMAND: undefined,
  ZCODE_AGENT_SERVER_ARGS_JSON: undefined,
};
const child = spawn(process.execPath, [entry, "serve", "--workspace", workspace, "--state-dir", stateDir, "--port", String(port)], {
  cwd: path.dirname(path.dirname(path.dirname(path.dirname(entry)))), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let childOutput = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => { childOutput = (childOutput + String(chunk)).slice(-4096); });
}
let exited = false;
child.once("exit", () => { exited = true; });

async function fetchBounded(url, init = {}) {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2000), ...init });
  const body = await response.text();
  if (body.length > 65536) throw new Error("candidate response too large");
  return { status: response.status, body };
}

function runtimePointer() {
  const dir = path.join(stateDir, "runtime");
  let files;
  try { files = readdirSync(dir).filter((name) => /^[0-9a-f]{12}\.json$/i.test(name)); }
  catch { return null; }
  if (files.length !== 1) return null;
  try { return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")); }
  catch { return null; }
}

let runtime = null;
try {
  const deadline = Date.now() + 20000;
  let health = null;
  while (Date.now() < deadline) {
    if (exited) throw new Error("candidate bridge exited before health check");
    runtime = runtimePointer();
    if (runtime?.pid === child.pid && runtime.port === port) {
      try {
        const probe = await fetchBounded(`http://127.0.0.1:${port}/health`);
        if (probe.status === 200) { health = JSON.parse(probe.body); break; }
      } catch { /* bounded startup retry */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!health || !runtime) throw new Error("isolated candidate did not become healthy within 20 seconds");
  if (health.status !== "ok" || health.workspaceId !== runtime.workspaceId ||
      health.release?.releaseId !== releaseId || health.release?.buildParity !== "ok" ||
      health.release?.sourceParity !== "ok" || typeof health.instanceId !== "string" ||
      health.instanceId.length < 16) throw new Error("isolated candidate identity mismatch");
  const unauthorized = await fetchBounded(`http://127.0.0.1:${port}/mcp`);
  if (unauthorized.status !== 401) throw new Error(`isolated MCP returned ${unauthorized.status}, expected 401`);
  const authenticated = await probeAuthenticatedMcp({
    publicBase: `http://127.0.0.1:${port}`,
    localBase: `http://127.0.0.1:${port}`,
    adminToken: runtime.adminToken,
    expectedWorkspaceId: runtime.workspaceId,
  });
  if (!authenticated.sharedToolsPresent) throw new Error("isolated authenticated MCP is missing shared agent plane tools");
  process.stdout.write(JSON.stringify({ ok: true, releaseId, pid: child.pid,
    compiledMapperRedactionForms: shortForms.length,
    compiledRejectionRedactionForms: shortForms.length,
    compiledAmbiguous: true,
    buildHash: manifest.buildHash,
    entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex"),
    instanceId: health.instanceId, workspaceId: health.workspaceId,
    localHealth: 200, unauthenticatedMcp: 401, authenticatedMcp: authenticated }) + "\n");
} catch (error) {
  // Only the bounded tail of this isolated child's output is retained. It
  // should not contain credentials, but do not print it on a public console.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  try {
    runtime ??= runtimePointer();
    if (!exited && runtime?.pid === child.pid && typeof runtime.adminToken === "string") {
      await fetchBounded(`http://127.0.0.1:${runtime.port}/admin/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${runtime.adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ expectedRuntime: { workspaceId: runtime.workspaceId, pid: runtime.pid,
          port: runtime.port, startedAt: runtime.startedAt, stateDomainGeneration: runtime.stateDomainGeneration } }),
      });
    }
  } catch { /* close the exact child below */ }
  const ended = exited || await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!ended && !exited) {
    child.kill("SIGTERM");
    const stopped = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 2000)),
    ]);
    if (!stopped && !exited) process.exitCode = 1;
  }
}
