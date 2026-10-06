import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import {
  computeIntegritySnapshot,
  IntegritySnapshotError,
} from "../src/workspace/integrity-snapshot.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { stableWorkspaceId } from "../src/workspace/identity.js";
import type { ModelCatalogService, ModelCatalog } from "../src/execution/model-catalog.js";
import { makeTmpDir, cleanup, write, makeGitRepo, isolateStateDir } from "./helpers.js";

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

function jsonOf<T = Record<string, unknown>>(result: { content?: unknown }): T {
  return JSON.parse(textOf(result)) as T;
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, body: jsonOf(result) };
}

describe("workspace integrity snapshot (core module)", () => {
  let root: string;
  const dirs: string[] = [];

  function setup(): string {
    root = makeTmpDir("integrity-ws");
    dirs.push(root);
    write(root, "alpha.txt", "alpha\n");
    write(root, ".hidden-dotfile", "hidden dot\n");
    write(root, "zero.bin", "");
    write(root, "node_modules/pkg/index.js", "module.exports = 1;\n");
    write(root, ".git/config", "[core]\n");
    write(root, "deep/nested/leaf.txt", "leaf\n");
    return root;
  }

  it("enumerates every normal file including hidden, zero-byte and filtered dirs, deterministically", async () => {
    const ws = setup();
    const first = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
    const second = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });

    expect(first.complete).toBe(true);
    expect(first.rootIdentityVerified).toBe(true);
    const paths = first.entries.map((entry) => entry.path);
    expect(paths).toEqual([
      ".git/config",
      ".hidden-dotfile",
      "alpha.txt",
      "deep/nested/leaf.txt",
      "node_modules/pkg/index.js",
      "zero.bin",
    ]);
    expect(paths).toEqual([...paths].sort());
    expect(first.totalFiles).toBe(6);
    expect(first.totalBytes).toBe(
      first.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
    );
    const zero = first.entries.find((entry) => entry.path === "zero.bin")!;
    expect(zero.sizeBytes).toBe(0);
    expect(zero.sha256).toBe(sha256(""));
    const alpha = first.entries.find((entry) => entry.path === "alpha.txt")!;
    expect(alpha.sha256).toBe(sha256("alpha\n"));
    expect(alpha.sizeBytes).toBe(6);
    expect(typeof alpha.lastWriteTimeUtc).toBe("string");
    expect(Number.isNaN(Date.parse(alpha.lastWriteTimeUtc))).toBe(false);
    expect(new Date(alpha.lastWriteTimeUtc).toISOString()).toBe(alpha.lastWriteTimeUtc);
    // Deterministic double snapshot: identical manifest digest.
    expect(second.manifestSha256).toBe(first.manifestSha256);
    expect(second.entries).toEqual(first.entries);
  });

  it("alters the manifest digest when content, size, mtime or path change", async () => {
    const ws = setup();
    const base = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });

    // Content-only change.
    write(root, "alpha.txt", "alpha!\n");
    const contentChanged = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
    expect(contentChanged.manifestSha256).not.toBe(base.manifestSha256);
    expect(contentChanged.entries.find((e) => e.path === "alpha.txt")!.sha256).not.toBe(
      base.entries.find((e) => e.path === "alpha.txt")!.sha256
    );

    // mtime-only change (same bytes and size) must still alter the digest.
    const target = path.join(root, "alpha.txt");
    const future = new Date(Date.now() + 3_600_000);
    fs.utimesSync(target, future, future);
    const mtimeChanged = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
    expect(mtimeChanged.manifestSha256).not.toBe(contentChanged.manifestSha256);
    const before = contentChanged.entries.find((e) => e.path === "alpha.txt")!;
    const after = mtimeChanged.entries.find((e) => e.path === "alpha.txt")!;
    expect(after.sha256).toBe(before.sha256);
    expect(after.sizeBytes).toBe(before.sizeBytes);
    expect(after.lastWriteTimeUtc).not.toBe(before.lastWriteTimeUtc);

    // Size change (append) alters the digest.
    fs.appendFileSync(target, "more\n");
    const sizeChanged = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
    expect(sizeChanged.manifestSha256).not.toBe(mtimeChanged.manifestSha256);

    // Path change (rename) alters the digest.
    fs.renameSync(target, path.join(root, "renamed.txt"));
    const pathChanged = await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
    expect(pathChanged.manifestSha256).not.toBe(sizeChanged.manifestSha256);
    expect(pathChanged.entries.some((e) => e.path === "renamed.txt")).toBe(true);
    expect(pathChanged.entries.some((e) => e.path === "alpha.txt")).toBe(false);
  });

  it("fails closed on junctions and symlinks before following them, with sanitized relative reasons", async () => {
    const ws = setup();
    // Junctions do not require elevated privileges on Windows; they must be
    // rejected whether they point inside or outside the workspace.
    const outsideTarget = makeTmpDir("integrity-outside");
    dirs.push(outsideTarget);
    fs.symlinkSync(outsideTarget, path.join(root, "escape-junction"), "junction");
    try {
      await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
      expect.unreachable("junction must fail closed");
    } catch (error) {
      expect(error).toBeInstanceOf(IntegritySnapshotError);
      const e = error as IntegritySnapshotError;
      expect(e.code).toBe("LINK_REJECTED");
      expect(e.relPath).toBe("escape-junction");
      expect(e.rootVerified).toBe(true);
      expect(e.message).not.toContain(outsideTarget);
      expect(e.message).not.toMatch(/[A-Za-z]:\\/);
    }

    fs.rmSync(path.join(root, "escape-junction"), { force: true });
    // An inward-pointing link is equally rejected: links are never followed.
    try {
      fs.symlinkSync(path.join(root, "alpha.txt"), path.join(root, "inward-link"), "file");
    } catch {
      // Windows without symlink privilege: the junction case above already
      // covers the link rejection contract.
      return;
    }
    try {
      await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
      expect.unreachable("symlink must fail closed");
    } catch (error) {
      expect((error as IntegritySnapshotError).code).toBe("LINK_REJECTED");
      expect((error as IntegritySnapshotError).relPath).toBe("inward-link");
    }
  });

  it("fails closed on entry limits instead of returning a truncated manifest", async () => {
    const ws = setup();
    try {
      await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws), maxEntries: 2 });
      expect.unreachable("limit must fail closed");
    } catch (error) {
      const e = error as IntegritySnapshotError;
      expect(e.code).toBe("ENTRY_LIMIT_EXCEEDED");
      expect(e.relPath).not.toBe(null);
      expect(path.isAbsolute(e.relPath!)).toBe(false);
    }
  });

  it("fails closed when the root identity does not match the registered workspace id", async () => {
    const ws = setup();
    try {
      await computeIntegritySnapshot({ root: ws, expectedId: "deadbeef0000" });
      expect.unreachable("identity mismatch must fail closed");
    } catch (error) {
      const e = error as IntegritySnapshotError;
      expect(e.code).toBe("ROOT_IDENTITY_CHANGED");
      expect(e.rootVerified).toBe(false);
      expect(e.relPath).toBe(null);
    }
  });

  it("fails closed when a file is mutated while being hashed", async () => {
    const ws = setup();
    const realOpen = fs.promises.open.bind(fs.promises);
    let fstatCalls = 0;
    const hooks = {
      openFile: async (abs: string): Promise<FileHandle> => {
        const handle = await realOpen(abs, "r");
        return {
          stat: async (options?: { bigint?: boolean }) => {
            fstatCalls++;
            const stats = await handle.stat(options);
            // Second (post-read) stat reports a mutated mtime.
            if (abs === path.join(root, "alpha.txt") && fstatCalls % 2 === 0 && options?.bigint) {
              return { size: stats.size, mtimeNs: stats.mtimeNs + 1n, isFile: () => true };
            }
            return stats;
          },
          read: handle.read.bind(handle),
          close: () => handle.close(),
        } as unknown as FileHandle;
      },
    };
    try {
      await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws), hooks });
      expect.unreachable("mutation during hash must fail closed");
    } catch (error) {
      const e = error as IntegritySnapshotError;
      expect(e.code).toBe("CHANGED_DURING_READ");
      expect(e.rootVerified).toBe(true);
      expect(e.relPath).toBe("alpha.txt");
    }
  });

  it("fails closed on unreadable files (POSIX permissions)", async () => {
    if (process.platform === "win32") return; // POSIX-only permission model
    const ws = setup();
    fs.chmodSync(path.join(root, "alpha.txt"), 0o000);
    try {
      await computeIntegritySnapshot({ root: ws, expectedId: stableWorkspaceId(ws) });
      expect.unreachable("unreadable file must fail closed");
    } catch (error) {
      const e = error as IntegritySnapshotError;
      expect(e.code).toBe("READ_FAILED");
      expect(e.relPath).toBe("alpha.txt");
    } finally {
      fs.chmodSync(path.join(root, "alpha.txt"), 0o644);
    }
  });
});

describe("workspace_integrity_snapshot MCP action", () => {
  const fakeCatalogAt = new Date().toISOString();
  const fakeCatalog = {
    get: async (agents?: string[]) => ({
      schema_version: 1 as const,
      catalog_revision: "test-revision",
      fetched_at: fakeCatalogAt,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      freshness: "fresh" as const,
      agents: (agents && agents.length > 0 ? agents : ["codex", "antigravity", "zcode"]).map((agent) => ({
        agent,
        source: "test-fixture",
        runtime_version: "test-1.0.0",
        auth_mode: "test",
        completeness: "complete",
        error: null,
        observed_at: fakeCatalogAt,
        models: [],
      })),
    }),
    peek: () => null,
    confirmCodexSelection: async () => ({ confirmed: true, revision: "test-revision", problem: null }),
    modelsOf: () => [],
  } as unknown as ModelCatalogService;

  let ws1: string;
  let ws2: string;
  let bridge: Bridge;
  let authorized: Client;
  let noReadScope: Client;
  let otherIdentity: Client;
  let ws1Id: string;
  let ws2Id: string;
  let ws3Id: string;
  const dirs: string[] = [];

  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: "integrity-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    return client;
  };

  beforeAll(async () => {
    isolateStateDir();
    ws1 = makeTmpDir("integrity-auth-ws1");
    ws2 = makeTmpDir("integrity-auth-ws2");
    const ws3 = makeTmpDir("integrity-auth-ws3");
    dirs.push(ws1, ws2, ws3);
    makeGitRepo(ws1);
    write(ws1, ".env", "API_KEY=supersecret\n");
    write(ws1, "empty.txt", "");
    for (let i = 0; i < 30; i++) write(ws1, `pages/generated-${String(i).padStart(3, "0")}.txt`, `page ${i}\n`);
    write(ws2, "other.txt", "disabled workspace\n");
    write(ws3, "secret.txt", "not for this caller\n");

    const registryFile = path.join(makeTmpDir("integrity-state"), "workspaces.json");
    const registry = new WorkspaceRegistry({ file: registryFile });
    const entry1 = registry.registerTrusted({ name: "ws-one", canonicalPath: ws1 });
    registry.registerTrusted({ name: "ws-two", canonicalPath: ws2, enabled: false });
    const entry3 = registry.registerTrusted({ name: "ws-three", canonicalPath: ws3 });
    ws1Id = entry1.id;
    ws2Id = registry.get(stableWorkspaceId(ws2)).id;
    ws3Id = entry3.id;

    bridge = await startBridge({
      workspaceRoot: ws1,
      port: 0,
      persistRuntime: false,
      modelCatalog: fakeCatalog,
      authStoreFile: path.join(makeTmpDir("integrity-auth"), "store.json"),
      workspaceRegistryFile: registryFile,
    });

    const readToken = bridge.authStore.issueTokens({
      clientId: "integrity-reader",
      scopes: ["workspace.read"],
      workspaceIds: [ws1Id],
    });
    authorized = await connect(readToken.accessToken);

    const limitedToken = bridge.authStore.issueTokens({
      clientId: "integrity-limited",
      scopes: ["execution.read"],
      workspaceIds: [ws1Id],
    });
    noReadScope = await connect(limitedToken.accessToken);

    const otherToken = bridge.authStore.issueTokens({
      clientId: "integrity-other",
      scopes: ["workspace.read"],
      workspaceIds: [ws3Id],
    });
    otherIdentity = await connect(otherToken.accessToken);
  });

  afterAll(async () => {
    await authorized?.close();
    await noReadScope?.close();
    await otherIdentity?.close();
    await bridge?.close();
    for (const dir of dirs) cleanup(dir);
  });

  it("requires the workspace.read scope", async () => {
    const { isError, body } = await callTool(noReadScope, "workspace_integrity_snapshot", { workspace_id: ws1Id });
    expect(isError).toBe(true);
    expect(body.error).toBe("INSUFFICIENT_SCOPE");
  });

  it("rejects unknown and disabled workspaces", async () => {
    const unknown = await callTool(authorized, "workspace_integrity_snapshot", { workspace_id: "deadbeef0000" });
    expect(unknown.isError).toBe(true);
    expect(unknown.body.error).toBe("WORKSPACE_NOT_FOUND");

    const disabled = await callTool(authorized, "workspace_integrity_snapshot", { workspace_id: ws2Id });
    expect(disabled.isError).toBe(true);
    expect(disabled.body.error).toBe("WORKSPACE_NOT_FOUND");
  });

  it("rejects workspaces outside the caller's authorization, regardless of registry state", async () => {
    const { isError, body } = await callTool(otherIdentity, "workspace_integrity_snapshot", { workspace_id: ws1Id });
    expect(isError).toBe(true);
    expect(body.error).toBe("WORKSPACE_NOT_AUTHORIZED");
  });

  it("snapshots the registry root only; caller path arguments are never accepted", async () => {
    const { isError, body } = await callTool(authorized, "workspace_integrity_snapshot", {
      workspace_id: ws1Id,
      path: "C:/Windows",
      absolute_path: "C:/Windows/System32/config",
    });
    expect(isError).toBe(false);
    expect(body.complete).toBe(true);
    expect(body.rootIdentityVerified).toBe(true);
    expect(body.workspaceId).toBe(ws1Id);
    const paths = (body.entries as Array<{ path: string }>).map((entry) => entry.path);
    // Hidden/sensitive/zero-byte files are enumerated (bodies are never returned).
    expect(paths).toContain(".env");
    expect(paths).toContain("empty.txt");
    expect(paths).toContain("hello.txt");
    expect(paths.some((p) => p.includes("/") || p.includes("\\"))).toBe(true);
    // No absolute path ever crosses the boundary.
    expect(textOf({ content: [{ type: "text", text: JSON.stringify(body) }] })).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it("paginates output while the manifest digest always covers ALL entries", async () => {
    const full = await callTool(authorized, "workspace_integrity_snapshot", { workspace_id: ws1Id, limit: 500 });
    expect(full.isError).toBe(false);
    const fullDigest = full.body.manifestSha256;
    const fullPaths = (full.body.entries as Array<{ path: string }>).map((entry) => entry.path);
    const totalEntries = (full.body.pagination as { totalEntries: number }).totalEntries;
    // The git fixture adds its own object/refs files; only assert the seeded set.
    expect(totalEntries).toBe(fullPaths.length);
    expect(totalEntries).toBeGreaterThan(34);

    const seen: string[] = [];
    let offset = 0;
    const digests = new Set<string>();
    for (let guard = 0; guard < 50; guard++) {
      const page = await callTool(authorized, "workspace_integrity_snapshot", {
        workspace_id: ws1Id,
        offset,
        limit: 10,
      });
      expect(page.isError).toBe(false);
      expect(page.body.complete).toBe(true);
      expect(page.body.manifestSha256).toBe(fullDigest);
      digests.add(page.body.manifestSha256 as string);
      const pagination = page.body.pagination as { returned: number; hasMore: boolean; nextOffset: number | null };
      const entries = (page.body.entries as Array<{ path: string }>).map((entry) => entry.path);
      seen.push(...entries);
      offset = pagination.nextOffset ?? -1;
      if (!pagination.hasMore) break;
    }
    expect(digests.size).toBe(1);
    expect(seen.length).toBe(totalEntries);
    expect(seen).toEqual([...seen].sort());
    // The union of pages equals the full (unpaginated) entry list.
    expect(seen).toEqual(fullPaths);
  });
});
