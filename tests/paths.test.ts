import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getDefaultStateDir,
  resolveStateDir,
  resolveWindowsLocalAppData,
} from "../src/config/paths.js";

const originalLocalAppData = process.env.LOCALAPPDATA;
const originalStateDir = process.env.C2C_STATE_DIR;

afterEach(() => {
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
});

describe("Windows C2C state-directory resolution", () => {
  it("keeps a normal Win32 LOCALAPPDATA value", () => {
    if (process.platform !== "win32") return;
    expect(
      resolveWindowsLocalAppData("C:\\Users\\Test\\AppData\\Local", "C:\\Users\\Test")
    ).toBe("C:\\Users\\Test\\AppData\\Local");
  });

  it("collapses packaged LOCALAPPDATA virtualization to the user Local AppData", () => {
    if (process.platform !== "win32") return;
    const home = "C:\\Users\\Test";
    expect(
      resolveWindowsLocalAppData(
        "C:\\Users\\Test\\AppData\\Local\\Packages\\Some.Package\\LocalCache\\Local",
        home
      )
    ).toBe("C:\\Users\\Test\\AppData\\Local");
  });

  it("uses the same default for the real profile and a packaged parent", () => {
    if (process.platform !== "win32") return;
    const home = os.homedir();
    const canonical = path.join(home, "AppData", "Local", "codex-with-chatgpt");
    process.env.LOCALAPPDATA = path.join(home, "AppData", "Local");
    const normal = getDefaultStateDir();
    process.env.LOCALAPPDATA = path.join(
      home,
      "AppData",
      "Local",
      "Packages",
      "Some.Package",
      "LocalCache",
      "Local"
    );
    const packaged = getDefaultStateDir();
    expect(normal).toBe(canonical);
    expect(packaged).toBe(canonical);
  });

  it("keeps an explicit C2C_STATE_DIR override authoritative", () => {
    process.env.LOCALAPPDATA = "C:\\Users\\Test\\AppData\\Local\\Packages\\Some.Package\\LocalCache\\Local";
    process.env.C2C_STATE_DIR = "D:\\C2C\\isolated-state";
    expect(resolveStateDir()).toBe(path.resolve("D:\\C2C\\isolated-state"));
  });
});
