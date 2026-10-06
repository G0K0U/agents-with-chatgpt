import path from "node:path";
import { spawn } from "node:child_process";
import { pnpmProjectSpec } from "./package-manager.js";

try {
  const argv = process.argv.slice(2);
  const spec = pnpmProjectSpec(process.cwd(), argv) ?? "pnpm";
  const corepack = path.join(path.dirname(process.execPath), "node_modules/corepack/dist/corepack.js");
  const child = spawn(process.execPath, [corepack, spec, ...argv], { stdio: "inherit", windowsHide: true });
  child.on("error", () => { console.error("PACKAGE_MANAGER_UNAVAILABLE"); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
} catch {
  console.error("PACKAGE_MANAGER_PIN_INVALID: unable to resolve the requested project's pinned pnpm");
  process.exitCode = 1;
}
