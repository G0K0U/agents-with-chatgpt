// Regression tests for the desktop-agent-proxy registration publish (EXDEV fix).
// Root cause: the registration temp file was created in os.tmpdir() (which may
// live on a different volume than the state dir) and then rename()d across
// volumes -> EXDEV -> uncaught exception inside the control-channel listen
// callback -> proxy crash -> Desktop agent restart loop.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse as parsePath } from "node:path";

const PROXY = join(process.cwd(), "scripts", "desktop-agent-proxy.mjs");
const FAKE_AGENT = join(process.cwd(), "test", "fixtures", "fake-agent.mjs");

describe("desktop proxy registration publish (EXDEV regression)", () => {
  it("implementation never relies on os.tmpdir() for the atomic rename", () => {
    const src = readFileSync(PROXY, "utf8");
    // no tmpdir import and no tmpdir-based path construction anywhere: the
    // temp file can only be built inside the destination directory
    const osImport = src.match(/import \{([^}]*)\} from "node:os"/)?.[1] ?? "";
    assert.ok(!osImport.includes("tmpdir"), "os.tmpdir must not be imported");
    assert.ok(!src.includes("join(tmpdir()"), "no path may be built from os.tmpdir()");
    assert.ok(
      src.includes("join(AGENT_DIR, `.${basename(STATE_FILE)}"),
      "temp file must be created inside the destination directory (same volume as the rename target)",
    );
    assert.ok(
      src.includes("renameSync(tmp, STATE_FILE)"),
      "publication must atomically rename tmp -> destination",
    );
    assert.ok(src.includes("unlinkSync(tmp)"), "failed publications must clean up the temp file");
    assert.ok(!src.includes("z2c-agent-"), "old cross-volume temp naming must be gone");
  });

  it("publishes the registration when TMP/TEMP point at a different volume", { skip: skipReason() }, () => {
    const pair = pickCrossVolumePair()!;
    const workspace = process.cwd(); // becomes the proxy's WORKSPACE identity
    const proxy: ChildProcess = spawn(process.execPath, [PROXY, "--stdio"], {
      cwd: workspace,
      env: {
        ...process.env,
        Z2C_STATE_DIR: pair.stateDir, // destination volume
        Z2C_ZCODE_CLI: FAKE_AGENT,
        TMP: pair.tmpRoot, // os.tmpdir() volume, different from the destination
        TEMP: pair.tmpRoot,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      const hash = createHash("sha1").update(workspace.toLowerCase()).digest("hex").slice(0, 16);
      const agentDir = join(pair.stateDir, "desktop-agents");
      const stateFile = join(agentDir, `agent-${hash}.json`);
      const deadline = Date.now() + 15000;
      while (!existsSync(stateFile)) {
        assert.ok(
          proxy.pid != null && proxy.exitCode === null,
          "proxy exited before publishing its registration (crash-loop regression)",
        );
        assert.ok(Date.now() < deadline, "registration file was not published in time");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
      const reg = JSON.parse(readFileSync(stateFile, "utf8")) as {
        port: number;
        token: string;
        pid: number;
        workspace: string;
      };
      assert.equal(typeof reg.port, "number");
      assert.ok(reg.port > 0);
      assert.equal(typeof reg.token, "string");
      assert.ok(reg.token.length >= 32);
      assert.equal(typeof reg.pid, "number");
      assert.equal(reg.workspace, workspace);
      // the same-directory temp file must never be left behind in AGENT_DIR
      const litter = readdirSync(agentDir).filter((f) => f.endsWith(".tmp"));
      assert.deepEqual(litter, []);
      // proxy stays alive (no crash loop)
      assert.ok(proxy.pid != null && proxy.exitCode === null, "proxy must stay alive after publishing");
    } finally {
      proxy.kill();
      rmSync(pair.stateDir, { recursive: true, force: true });
      rmSync(pair.tmpRoot, { recursive: true, force: true });
    }
  });
});

function skipReason(): string | false {
  return pickCrossVolumePair() === null
    ? "no second writable volume available to exercise a cross-volume rename"
    : false;
}

function rootOf(p: string): string {
  return parsePath(p).root;
}

function tryMkdtemp(candidateDir: string): string | null {
  try {
    return mkdtempSync(join(candidateDir, "z2c-xvol-"));
  } catch {
    return null;
  }
}

/** Find a writable (stateDir, tmpRoot) pair whose volumes differ; null if impossible. */
function pickCrossVolumePair(): { stateDir: string; tmpRoot: string } | null {
  const stateRoots = [process.env.LOCALAPPDATA, join(homedir(), "AppData", "Local"), tmpdir()].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const tmpRoots = [tmpdir(), "D:\\", "E:\\", process.env.LOCALAPPDATA ?? "", join(homedir(), "AppData", "Local")].filter(
    (p): p is string => p.length > 0,
  );
  for (const s of stateRoots) {
    const stateDir = tryMkdtemp(s);
    if (!stateDir) continue;
    for (const t of tmpRoots) {
      if (rootOf(t) === rootOf(stateDir)) continue;
      const tmpRoot = tryMkdtemp(t);
      if (tmpRoot) return { stateDir, tmpRoot };
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
  return null;
}
