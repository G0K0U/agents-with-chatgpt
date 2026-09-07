import { initializeStateDir } from "../config/paths.js";
import { runRestartHelper } from "./restart.js";

// Dedicated hidden entry, deliberately outside Commander: no arbitrary workspace,
// executable, path, command, or recursive restart arguments are accepted.
try {
  if (process.argv.length !== 3 || process.env.C2C_RESTART_HELPER !== "1" || !process.env.C2C_STATE_DIR) throw new Error("Invalid helper invocation");
  const state = initializeStateDir(process.env.C2C_STATE_DIR);
  const result = await runRestartHelper(process.argv[2]!, state.stateDir);
  process.exitCode = result.state === "complete" ? 0 : 1;
} catch {
  process.exitCode = 1;
}
