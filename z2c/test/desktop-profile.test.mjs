import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { win32 as path } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  resolveCanonicalProfile,
  resolveZCodeCredentialStore,
  buildDesktopChildEnv,
} from "../scripts/desktop-profile.mjs";

test("Desktop host and bundled agent use the canonical Windows profile under isolated HOME", () => {
  const env = {
    HOME: "C:/isolated_home",
    USERPROFILE: "C:/isolated_home",
    LOCALAPPDATA: "C:/Users/Test/AppData/Local",
    PATH: "test-path",
  };
  const profile = resolveCanonicalProfile(env, "win32");
  const slash = (value) => value.replaceAll("\\", "/");
  assert.equal(slash(profile), "C:/Users/Test");
  assert.equal(slash(resolveZCodeCredentialStore(profile, "win32")),
    "C:/Users/Test/.zcode/v2/credentials.json");

  for (const name of ["desktop-host-shim", "desktop-agent-proxy"]) {
    const url = new URL(`../scripts/${name}.mjs`, import.meta.url);
    const source = readFileSync(url, "utf8");
    const stop = name === "desktop-host-shim" ? 'log("proxy.spawn"' : 'log("child.spawn"';
    assert.ok(source.includes(stop));
    // Evaluate the actual startup/spawn configuration with all side effects stubbed.
    const startup = source.slice(0, source.indexOf(stop))
      .replace(/^import\s[\s\S]*?;$/gm, "")
      .replaceAll("import.meta.url", JSON.stringify(url.href));
    let spawned;
    const context = {
      process: { env, cwd: () => "C:/workspace", execPath: "node", pid: 1 },
      ...path,
      fileURLToPath,
      createHash,
      resolveCanonicalProfile: () => resolveCanonicalProfile(env, "win32"),
      resolveZCodeCredentialStore: (value) => resolveZCodeCredentialStore(value, "win32"),
      buildDesktopChildEnv: (value) => buildDesktopChildEnv(value, env),
      mkdirSync() {},
      appendFileSync() {},
      spawn(command, args, options) { spawned = { command, args, options }; return {}; },
    };
    const resolved = runInNewContext(startup +
      '\n({ profile: CANONICAL_PROFILE, credential: typeof CREDENTIAL_STORE === "undefined" ? null : CREDENTIAL_STORE })', context);
    assert.equal(slash(resolved.profile), "C:/Users/Test");
    if (resolved.credential) assert.equal(slash(resolved.credential),
      "C:/Users/Test/.zcode/v2/credentials.json");
    assert.equal(slash(spawned.options.env.HOME), "C:/Users/Test");
    assert.equal(slash(spawned.options.env.USERPROFILE), "C:/Users/Test");
    assert.equal(spawned.options.env.LOCALAPPDATA, env.LOCALAPPDATA);
    assert.equal(spawned.options.env.PATH, env.PATH);
    if (name === "desktop-agent-proxy") {
      assert.equal(slash(spawned.args[0]), "C:/Users/Test/AppData/Local/Programs/ZCode/resources/glm/zcode.cjs");
      assert.deepEqual(Array.from(spawned.args.slice(1)), ["app-server", "--stdio", "--surface", "desktop"]);
    }
  }
  assert.equal(env.HOME, "C:/isolated_home");
  for (const LOCALAPPDATA of ["relative/AppData/Local", "/Users/Test/AppData/Local", "C:/Users/Test/Other", "C:/Users/../AppData/Local"]) {
    assert.equal(resolveCanonicalProfile({ ...env, LOCALAPPDATA }, "win32"), env.USERPROFILE);
  }
  assert.equal(resolveCanonicalProfile({ USERPROFILE: "relative" }, "win32"), homedir());
});
