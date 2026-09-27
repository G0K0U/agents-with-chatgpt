/**
 * Shared-platform environment namespace: A2C_* is canonical; the historical
 * C2C_* names remain accepted as legacy compatibility identifiers (existing
 * deployments set them). Provider-lane variables are NOT shared: Z2C_* (ZCode
 * lane), CODEX_HOME (Codex lane) are untouched.
 */
export function sharedEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const a2c = env[`A2C_${name}`];
  if (a2c !== undefined) return a2c;
  return env[`C2C_${name}`];
}

/** Set a shared-platform variable in BOTH namespaces (writes must reach old and new readers). */
export function setSharedEnv(target: NodeJS.ProcessEnv, name: string, value: string | undefined): void {
  if (value === undefined) {
    delete target[`A2C_${name}`];
    delete target[`C2C_${name}`];
    return;
  }
  target[`A2C_${name}`] = value;
  target[`C2C_${name}`] = value;
}
