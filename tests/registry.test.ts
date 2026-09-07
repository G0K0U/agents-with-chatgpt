import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceRegistry, WorkspaceRegistryError } from "../src/workspace/registry.js";
import { stableWorkspaceId } from "../src/workspace/identity.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

describe("bridge-owned workspace registry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanup(dir);
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): { root: string; second: string; file: string } {
    isolateStateDir();
    const root = makeTmpDir("registry-root");
    const second = makeTmpDir("registry-second");
    const state = makeTmpDir("registry-state");
    dirs.push(root, second, state);
    write(root, "src/index.ts", "export const root = true;\n");
    write(second, "README.md", "second workspace\n");
    return { root, second, file: path.join(state, "workspaces.json") };
  }

  it("registers pre-authorized roots with stable ids and survives restart", () => {
    const { root, second, file } = setup();
    const registry = new WorkspaceRegistry({ file });
    const first = registry.registerTrusted({ name: "engineering-ai", canonicalPath: root });
    const secondEntry = registry.registerTrusted({ name: "c2c-bridge", canonicalPath: second });

    expect(first.id).toBe(stableWorkspaceId(root));
    expect(secondEntry.id).toBe(stableWorkspaceId(second));
    expect(registry.listMetadata()).toEqual([
      { id: first.id, name: "engineering-ai", enabled: true },
      { id: secondEntry.id, name: "c2c-bridge", enabled: true },
    ]);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).workspaces[0].canonicalPath).toBe(root);

    const restarted = new WorkspaceRegistry({ file });
    expect(restarted.get(first.id).id).toBe(first.id);
    expect(restarted.get(secondEntry.id).canonicalPath).toBe(second);
  });

  it("canonicalizes a directory junction and binds identity to the target root", () => {
    const { root, file } = setup();
    const linkParent = makeTmpDir("registry-link");
    dirs.push(linkParent);
    const junction = path.join(linkParent, "linked-root");
    fs.symlinkSync(root, junction, "junction");

    const registry = new WorkspaceRegistry({ file });
    const registered = registry.registerTrusted({ name: "linked", canonicalPath: junction });
    expect(registered.canonicalPath).toBe(root);
    expect(registry.getWorkspace(registered.id).root).toBe(root);
  });

  it("fails closed when a persisted id/root binding is spoofed", () => {
    const { root, second, file } = setup();
    write(path.dirname(file), path.basename(file), JSON.stringify({
      version: 1,
      workspaces: [{
        id: stableWorkspaceId(root),
        name: "spoofed",
        canonicalPath: second,
        enabled: true,
        createdAt: new Date().toISOString(),
      }],
    }));
    expect(() => new WorkspaceRegistry({ file })).toThrowError(WorkspaceRegistryError);
  });

  it("returns distinct not-found and duplicate-root errors", () => {
    const { root, file } = setup();
    const registry = new WorkspaceRegistry({ file });
    const entry = registry.registerTrusted({ name: "root", canonicalPath: root });
    expect(() => registry.get("deadbeef0000")).toThrowError(/Unknown workspace/);
    expect(() => registry.registerTrusted({ name: "duplicate", canonicalPath: root, id: entry.id })).not.toThrow();
    expect(() => registry.registerTrusted({ name: "wrong", canonicalPath: root, id: "deadbeef0000" })).toThrowError(
      /does not match/
    );
  });
});

