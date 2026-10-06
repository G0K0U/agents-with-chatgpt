import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeSecureJson } from "../config/paths.js";

/** Installation identity is durable; neither PID nor workspace is a host id. */
export function installationIdentity(stateDir: string): string {
  const file = path.join(stateDir, "installation-identity.json");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.schema !== 1 || !/^[0-9a-f-]{36}$/i.test(saved.installation_id)) throw new Error("invalid installation identity");
    return saved.installation_id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const id = randomUUID();
    writeSecureJson(file, { schema: 1, installation_id: id }, { durable: true });
    return id;
  }
}
