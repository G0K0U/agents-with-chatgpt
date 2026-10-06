import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pnpmProjectSpec } from "../src/util/package-manager.js";

it("routes Corepack to the target package pin rather than the cwd default", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "z2c-pnpm-"));
  try {
    fs.mkdirSync(path.join(root, "apps/web"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ packageManager: "pnpm@12.3.4" }));
    const file = path.join(root, "apps/web/package.json");
    fs.writeFileSync(file, JSON.stringify({ packageManager: "pnpm@11.24.0" }));
    for (const args of [["--dir", "apps/web", "typecheck"], ["-C", "apps/web", "lint"], ["--dir=apps/web", "test"]]) {
      assert.equal(pnpmProjectSpec(root, args), "pnpm@11.24.0");
    }
    assert.equal(pnpmProjectSpec(root, ["--version"]), "pnpm@12.3.4");
    fs.writeFileSync(file, JSON.stringify({ packageManager: "pnpm@11.24.0;bad" }));
    assert.throws(() => pnpmProjectSpec(root, ["--dir", "apps/web"]), /PIN_INVALID/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
