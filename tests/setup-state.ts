import { afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// No offline test may consume the operator's durable authorization, tasks,
// registry or pause policy. Tests can still replace this with their own fixture.
// Do not import helpers here: its catalog fixture loads provider modules before
// test-file mocks run, defeating subprocess isolation in provider contract tests.
const fixtureRoot = path.resolve(process.env.C2C_TEST_TMP_ROOT?.trim() ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tooling", "test-tmp"));
fs.mkdirSync(fixtureRoot, { recursive: true });
const realRoot = fs.realpathSync.native(fixtureRoot);
const fixtureState = path.join(realRoot, `setup-state-${randomBytes(8).toString("hex")}`);
fs.mkdirSync(fixtureState);
process.env.A2C_STATE_DIR = fixtureState;
process.env.C2C_STATE_DIR = fixtureState;
afterAll(() => {
  const target = path.resolve(fixtureState);
  if (path.dirname(target) !== realRoot || !path.basename(target).startsWith("setup-state-")) {
    throw new Error("Unsafe setup fixture cleanup");
  }
  fs.rmSync(target, { recursive: true, force: true });
});
