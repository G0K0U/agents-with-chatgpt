import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Atomic JSON file persistence (write temp + rename). */
export function loadJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function saveJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  // Flush the installed file too. Windows does not support opening directory
  // handles through Node; on POSIX also make the rename durable in its parent.
  const installed = openSync(path, "r+");
  try { fsyncSync(installed); } finally { closeSync(installed); }
  if (process.platform !== "win32") {
    const parent = openSync(dirname(path), "r");
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
