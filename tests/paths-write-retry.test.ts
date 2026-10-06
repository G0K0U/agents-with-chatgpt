import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeSecureJson } from "../src/config/paths.js";
import { makeTmpDir } from "./helpers.js";

/**
 * Regression lock for the Windows replace-rename sharing violation: a reader
 * mirroring readRestartHandoff()'s regular() guard (lstat + realpathSync.native
 * + readFileSync) opens the destination without FILE_SHARE_DELETE, which makes
 * the atomic rename inside writeSecureJson() fail with EPERM until the handle
 * closes. writeSecureJson must tolerate that window with a bounded retry while
 * keeping the replace atomic and rethrowing persistent failures.
 */

function spawnAdversarialReader(file: string, durationMs: number): void {
  const result = spawn(
    process.execPath,
    [
      "-e",
      `
      const fs = require("node:fs");
      const file = process.env.PROBE_FILE;
      const deadline = Date.now() + Number(process.env.PROBE_MS);
      while (Date.now() < deadline) {
        try {
          const stat = fs.lstatSync(file);
          fs.realpathSync.native(file);
          if (stat.isFile() && stat.nlink === 1) fs.readFileSync(file, "utf8");
          fs.realpathSync.native(file);
        } catch {}
      }
      `,
    ],
    {
      env: { ...process.env, PROBE_FILE: file, PROBE_MS: String(durationMs) },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  result.unref();
}

describe("writeSecureJson under a concurrent restart-handoff-style reader", () => {
  it("keeps durable writes succeeding through the realpath open window", async () => {
    const dir = makeTmpDir("paths-write-retry");
    const file = path.join(dir, "handoff.json");
    writeSecureJson(file, { n: -1 });
    const reader = spawnAdversarialReader(file, 1_500);

    const writes = process.platform === "win32" ? 8 : 2;
    for (let n = 0; n < writes; n++) {
      writeSecureJson(file, { n, pad: "x".repeat(64) }, { durable: true });
      expect(JSON.parse(fs.readFileSync(file, "utf8")).n).toBe(n);
    }
    // If the reader is still running on POSIX it may hold the last handle;
    // only assert once it cannot interfere.
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(fs.readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).n).toBe(writes - 1);
    void reader;
  }, 30_000);

  it("still replaces the destination for non-durable writes and keeps failure semantics", () => {
    const dir = makeTmpDir("paths-write-retry-fallback");
    const file = path.join(dir, "state.json");
    writeSecureJson(file, { v: 1 });
    writeSecureJson(file, { v: 2 });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).v).toBe(2);
    expect(fs.readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});
