import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve the requested package before Corepack starts (Corepack otherwise
 * sees only cwd, ignoring pnpm --dir/-C and choosing its global default). */
export function pnpmProjectSpec(cwd: string, args: readonly string[]): string | null {
  let dir = cwd;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--dir" || arg === "-C") {
      if (!args[i + 1]) throw new Error("PACKAGE_MANAGER_DIRECTORY_MISSING");
      dir = path.resolve(cwd, args[++i]!);
      break;
    }
    if (arg.startsWith("--dir=")) { dir = path.resolve(cwd, arg.slice(6)); break; }
  }
  for (;;) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest)) {
      const pin = JSON.parse(fs.readFileSync(manifest, "utf8")).packageManager;
      if (pin !== undefined) {
        if (typeof pin !== "string" || !/^pnpm@\d+\.\d+\.\d+(?:\+sha(?:224|256|384|512)\.[a-f0-9]+)?$/.test(pin)) {
          throw new Error("PACKAGE_MANAGER_PIN_INVALID");
        }
        return pin;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function managedPackageManagerEnv(stateDir: string, env: Record<string, string>): Record<string, string> {
  const corepack = path.join(path.dirname(process.execPath), "node_modules/corepack/dist/corepack.js");
  if (!fs.existsSync(corepack)) return env; // Native standalone pnpm needs no Corepack adapter.
  const dir = path.join(stateDir, "provider-toolchain-v1");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shim = fileURLToPath(new URL("./pnpm-shim.js", import.meta.url));
  // Generated wrappers are private provider runtime files; user toolchain and
  // project manifests are untouched. argv is forwarded without shell parsing.
  const sq = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const files = {
    "pnpm": `#!/bin/sh\nexec ${sq(process.execPath)} ${sq(shim)} "$@"\n`,
    "pnpm.cmd": `@echo off\r\n"${process.execPath}" "${shim}" %*\r\n`,
    "pnpm.ps1": `& '${process.execPath.replaceAll("'", "''")}' '${shim.replaceAll("'", "''")}' @args\nexit $LASTEXITCODE\n`,
  };
  for (const [name, contents] of Object.entries(files)) {
    const target = path.join(dir, name);
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === contents) continue;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, contents, { mode: 0o700 });
    fs.renameSync(tmp, target);
  }
  const key = Object.keys(env).find(k => k.toLowerCase() === "path") ?? "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ""}` };
}
