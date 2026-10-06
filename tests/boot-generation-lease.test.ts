import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeTmpDir, cleanup } from "./helpers.js";
const boot = vi.hoisted(() => ({ id: "boot-before", generation: "owner-one" }));
vi.mock("../src/bridge/boot-identity.js", () => ({ currentBootId: () => boot.id, get runtimeGeneration() { return boot.generation; } }));
import { acquireWorkspaceSlot, readWorkspaceSlot, reconcileWorkspaceSlot, renewWorkspaceSlot } from "../src/execution/slot.js";
const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach(cleanup); boot.id = "boot-before"; boot.generation = "owner-one"; });
function state() { const dir = makeTmpDir("boot-leases"); dirs.push(dir); return dir; }
describe("cold boot writer fencing", () => {
  it("invalidates a prior kernel boot lease even if the recorded PID was reused", () => {
    const dir = state(); acquireWorkspaceSlot("fixture", "c2c_12345678", dir, "z2c");
    boot.id = "boot-after"; boot.generation = "owner-two";
    const result = reconcileWorkspaceSlot("fixture", () => ({ workspaceId: "fixture", status: "running" }), dir);
    expect(result.cleared).toBe(true); expect(readWorkspaceSlot("fixture", dir)).toBe(null);
    acquireWorkspaceSlot("fixture", "c2c_87654321", dir, "z2c");
    expect(readWorkspaceSlot("fixture", dir)?.bootId).toBe("boot-after");
  });
  it("retains an expired same-boot native writer until authoritative task proof", () => {
    const dir = state(); const lease = acquireWorkspaceSlot("fixture", "c2c_12345678", dir, "z2c");
    fs.writeFileSync(path.join(dir, "locks/fixture.json"), JSON.stringify({ ...lease, leaseExpiresAt: new Date(0).toISOString() }));
    expect(reconcileWorkspaceSlot("fixture", () => null, dir).cleared).toBe(false);
    boot.generation = "another-process";
    expect(renewWorkspaceSlot("fixture", lease.taskId, dir)).toBe(false);
  });
  it("preserves an unknown legacy lock and blocks a conflicting new writer", () => {
    const dir = state(); fs.mkdirSync(path.join(dir, "tasks/fixture"), { recursive: true });
    const file = path.join(dir, "tasks/fixture/.writer-lock.json"); fs.writeFileSync(file, "unknown evidence");
    reconcileWorkspaceSlot("fixture", () => null, dir);
    expect(fs.readFileSync(file, "utf8")).toBe("unknown evidence");
    expect(() => acquireWorkspaceSlot("fixture", "c2c_12345678", dir)).toThrow();
  });
});
