import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { C2CSessionRegistry, SessionRegistryError } from "../src/session/registry.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("persistent C2C session registry", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) cleanup(dir);
    delete process.env.C2C_STATE_DIR;
  });

  function setup(): { file: string; root: string } {
    isolateStateDir();
    const root = makeTmpDir("session-root");
    const state = makeTmpDir("session-state");
    dirs.push(root, state);
    return { file: path.join(state, "registry.json"), root };
  }

  it("persists minimal sanitized continuation metadata without raw conversation data", () => {
    const { file, root } = setup();
    const registry = new C2CSessionRegistry({ file });
    const session = registry.create({
      ownerId: "client-a",
      workspaceId: "1a2b3c4d5e6f",
      title: "Fix assistant UI",
      goalSummary: `Continue work in ${root} and never persist a secret`,
    });
    registry.updateFromTask({
      sessionId: session.id,
      ownerId: "client-a",
      workspaceId: "1a2b3c4d5e6f",
      taskId: "c2c_abcdef12",
      status: "interrupted",
      changedFiles: ["src/app.ts", `${root}/secret.txt`, "../outside.txt"],
      tests: "verification passed",
      verificationStatus: "passed",
    });

    const persisted = fs.readFileSync(file, "utf8");
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain("threadId");
    expect(persisted).not.toContain("chain-of-thought");
    expect(persisted).toContain("[local-path]");

    const restarted = new C2CSessionRegistry({ file });
    const recovered = restarted.getOwned(session.id, "client-a", "1a2b3c4d5e6f");
    expect(recovered.lastTaskId).toBe("c2c_abcdef12");
    expect(recovered.changedFiles).toEqual(["src/app.ts"]);
    expect(recovered.currentState).toBe("interrupted");
  });

  it("enforces owner and workspace isolation", () => {
    const { file } = setup();
    const registry = new C2CSessionRegistry({ file });
    const session = registry.create({ ownerId: "client-a", workspaceId: "aaaaaaaaaaaa", title: "A", goalSummary: "A" });
    expect(() => registry.getOwned(session.id, "client-b")).toThrowError(SessionRegistryError);
    expect(() => registry.getOwned(session.id, "client-a", "bbbbbbbbbbbb")).toThrowError(SessionRegistryError);
    expect(registry.listForOwner("client-a", ["bbbbbbbbbbbb"])).toHaveLength(0);
    expect(registry.listForOwner("client-a", ["aaaaaaaaaaaa"])).toHaveLength(1);
  });

  it("orders active sessions newest first and does not prefer completed sessions", async () => {
    const { file } = setup();
    const registry = new C2CSessionRegistry({ file });
    const older = registry.create({ ownerId: "client-a", workspaceId: "aaaaaaaaaaaa", title: "older", goalSummary: "older" });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = registry.create({ ownerId: "client-a", workspaceId: "bbbbbbbbbbbb", title: "newer", goalSummary: "newer" });
    registry.setStatus(older.id, "client-a", "completed");
    const sessions = registry.listForOwner("client-a", ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
    expect(sessions[0].id).toBe(older.id);
    expect(sessions.find((entry) => entry.status === "active")?.id).toBe(newer.id);
  });
});
