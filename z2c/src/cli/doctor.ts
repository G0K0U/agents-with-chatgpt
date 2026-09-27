import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { loadConfig, resolveCliSpawn } from "../config.js";
import { existingService, pidFilePath } from "../service/main.js";
import { loadWorkspaceGrants } from "../authz/grants.js";
import { loadPairing } from "../authz/pairing.js";
import { loadSessionOwnership } from "../authz/ownership.js";
import { fingerprintSecret, loadOrCreateSecurity } from "../service/security.js";
import { Z2C_PROTOCOL_VERSION } from "../version.js";

/**
 * z2c doctor — migration/diagnostic report. Detects stale Phase-1 configuration
 * (e.g. a User-scope Z2C_PROVIDER=desktop leftover), legacy proxy injection,
 * service health, grants/pairing state, and port conflicts. NEVER prints
 * credential values — only names and fingerprints.
 */

interface Finding {
  severity: "ok" | "warn" | "error" | "info";
  check: string;
  detail: string;
}

function regQuery(name: string): string | null {
  if (process.platform !== "win32") return null;
  try {
    const raw = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const match = raw.match(new RegExp(`${name}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.*)`, "i"));
    const value = match?.[1]?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function commandLineOf(pid: number): string | null {
  if (process.platform !== "win32") return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`],
      { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function runDoctor(): Promise<number> {
  const findings: Finding[] = [];
  const cfg = loadConfig();

  // 1. ZCode runtime + official provider availability.
  findings.push({ severity: existsSync(cfg.zcodeCliPath) ? "ok" : "error", check: "zcode-agent-path", detail: cfg.zcodeCliPath });
  if (existsSync(cfg.zcodeCliPath)) {
    try {
      const { command, args } = resolveCliSpawn(cfg.zcodeCliPath, ["--version"]);
      const version = execFileSync(command, args, { encoding: "utf8", timeout: 20000 });
      const ok = version.trim().startsWith(cfg.expectedZcodeVersionPrefix);
      findings.push({ severity: ok ? "ok" : "warn", check: "zcode-agent-version", detail: `detected ${version.trim()}, expected ${cfg.expectedZcodeVersionPrefix}x` });
    } catch (err) {
      findings.push({ severity: "error", check: "zcode-agent-version", detail: `could not execute agent: ${(err as Error).message.slice(0, 80)}` });
    }
  }
  findings.push({
    severity: cfg.providerMode === "official" ? "ok" : "warn",
    check: "provider-mode",
    detail: cfg.providerMode === "official"
      ? "official (default; ZCode-native auth)"
      : cfg.providerMode === "desktop-legacy"
        ? "desktop-legacy — DEPRECATED compatibility mode; never started automatically and scheduled for deletion"
        : "headless — legacy lane; requires an explicitly user-owned Z2C_MODEL_API_KEY and cannot use ZCode-native auth",
  });

  // 2. Stale legacy configuration (persistent env, not just this shell).
  const staleProvider = process.env.Z2C_PROVIDER ?? regQuery("Z2C_PROVIDER");
  if (staleProvider && !["official", "headless"].includes(staleProvider.trim().toLowerCase())) {
    findings.push({
      severity: "warn",
      check: "stale-env-z2c-provider",
      detail: `Z2C_PROVIDER='${staleProvider}' is a Phase-1 leftover. 'desktop' maps to deprecated desktop-legacy; clear the User environment variable to ride the official default (setx Z2C_PROVIDER official, then restart shells).`,
    });
  } else {
    findings.push({ severity: "ok", check: "stale-env-z2c-provider", detail: staleProvider ? `Z2C_PROVIDER=${staleProvider}` : "not set (official default)" });
  }
  if (regQuery("Z2C_ZCODE_CREDENTIALS") || process.env.Z2C_ZCODE_CREDENTIALS) {
    findings.push({ severity: "warn", check: "stale-env-credentials", detail: "Z2C_ZCODE_CREDENTIALS is OBSOLETE (Phase 2 removed credential reading); remove it" });
  }
  const agentCmd = process.env.ZCODE_AGENT_SERVER_COMMAND ?? regQuery("ZCODE_AGENT_SERVER_COMMAND") ?? "";
  const agentArgs = process.env.ZCODE_AGENT_SERVER_ARGS_JSON ?? regQuery("ZCODE_AGENT_SERVER_ARGS_JSON") ?? "";
  if ((agentCmd + agentArgs).toLowerCase().includes("desktop-agent-proxy") || (agentCmd + agentArgs).toLowerCase().includes("desktop-host-shim")) {
    findings.push({ severity: "warn", check: "legacy-proxy-injection", detail: "ZCODE_AGENT_SERVER_COMMAND points at the Z2C desktop proxy/shim — legacy injection detected; remove it so Desktop launches its own bundled agent" });
  } else {
    findings.push({ severity: "ok", check: "legacy-proxy-injection", detail: "not detected" });
  }
  if (process.env.Z2C_MODEL_API_KEY ?? regQuery("Z2C_MODEL_API_KEY")) {
    findings.push({ severity: "info", check: "legacy-api-key", detail: "Z2C_MODEL_API_KEY is set — used ONLY by the legacy headless lane (fingerprint " + "present, value never printed)" });
  }

  // 3. Service state.
  const svc = existingService(cfg.stateDir);
  findings.push({ severity: svc ? "ok" : "info", check: "service", detail: svc ? `running (pid ${svc.pid}, port ${svc.port}, protocol v${svc.protocolVersion})` : "not running (start with: z2c start)" });
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/health`);
    const body = (await res.json()) as { status?: string; provider?: string };
    findings.push({ severity: body.status === "ok" ? "ok" : "warn", check: "service-health", detail: `HTTP ${res.status}: ${JSON.stringify(body)}` });
  } catch {
    findings.push({ severity: svc && svc.port === cfg.port ? "error" : "info", check: "service-health", detail: svc && svc.port === cfg.port ? "pid file alive but health endpoint unreachable" : "unreachable (service not running)" });
  }

  // 4. Security material.
  const security = loadOrCreateSecurity(cfg.stateDir);
  findings.push({ severity: "ok", check: "install-identity", detail: `${security.state.installId} (service secret ${fingerprintSecret(security.currentSecret().secret)}, ${security.state.secrets.length} secret(s) on file)` });

  // 5. Grants / pairing / ownership.
  const grants = loadWorkspaceGrants(cfg.stateDir);
  findings.push({ severity: grants.list().length > 0 ? "ok" : "info", check: "workspace-grants", detail: grants.list().map((g) => `${g.workspaceId}${g.permissions.write ? "" : " (readonly)"}`).join(", ") || "none authorized yet (z2c workspace authorize <path>)" });
  const pairing = loadPairing(cfg.stateDir);
  const clients = pairing.listClients().filter((c) => c.state === "PAIRED");
  findings.push({ severity: "info", check: "pairing", detail: `state=${pairing.pairingState()}, paired clients=${clients.length}` });
  const ownership = loadSessionOwnership(cfg.stateDir);
  findings.push({ severity: "info", check: "owned-sessions", detail: `${ownership.listFor({ kind: "local", clientId: null, deviceName: null }).length} session(s) owned by Z2C` });

  // 6. Owned child processes.
  try {
    const { children } = JSON.parse((await import("node:fs")).readFileSync(joinSafe(cfg.stateDir, "children.json"), "utf8")) as { children?: Array<{ pid: number }> };
    findings.push({ severity: "info", check: "agent-children", detail: (children ?? []).map((c) => `pid ${c.pid}`).join(", ") || "none recorded" });
  } catch {
    findings.push({ severity: "info", check: "agent-children", detail: "none recorded" });
  }

  // 7. Port conflict: something else on our port?
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}/health`);
    const body = (await res.json()) as { z2c?: unknown };
    findings.push({ severity: "ok", check: "port", detail: `port ${cfg.port} answered (z2c health)` });
    void body;
  } catch {
    try {
      const res = await fetch(`http://${cfg.host}:${cfg.port}/`);
      findings.push({ severity: res.ok ? "warn" : "info", check: "port", detail: `port ${cfg.port} is occupied by a non-Z2C listener (HTTP ${res.status})` });
    } catch {
      findings.push({ severity: "info", check: "port", detail: `port ${cfg.port} free or listener not HTTP` });
    }
  }

  // Report.
  let errors = 0;
  for (const f of findings) {
    if (f.severity === "error") errors += 1;
    const marker = f.severity === "ok" ? "[ok]" : f.severity === "warn" ? "[WARN]" : f.severity === "error" ? "[FAIL]" : "[info]";
    console.log(`${marker} ${f.check}: ${f.detail}`);
  }
  console.log(`\nz2c doctor: protocol v${Z2C_PROTOCOL_VERSION}, ${errors} error(s)`);
  return errors > 0 ? 1 : 0;
}

function joinSafe(base: string, name: string): string {
  return base.endsWith("\\") || base.endsWith("/") ? `${base}${name}` : `${base}/${name}`;
}

// Re-exported for CLI status surfaces.
export { existingService, pidFilePath };
