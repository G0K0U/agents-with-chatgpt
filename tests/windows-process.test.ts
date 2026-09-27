import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSyncMock = vi.fn((_cmd, _args, _opts) => ({
  status: 0,
  stdout: "",
  stderr: "",
  output: [],
  pid: 12345,
  signal: null,
}));

const spawnMock = vi.fn((_cmd, _args, _opts) => ({
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  pid: 12345,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: (...args: any[]) => spawnSyncMock(...args),
    spawn: (...args: any[]) => spawnMock(...args),
  };
});

import { runGit } from "../src/workspace/git.js";
import { findRipgrep, resetRipgrepCache } from "../src/workspace/search.js";
import { findBinary } from "../src/tunnel/detect.js";
import { ProcessCloudflaredAccount } from "../src/tunnel/named-provision.js";

describe("Windows background process windowsHide flag", () => {
  beforeEach(() => {
    resetRipgrepCache();
    spawnSyncMock.mockClear();
    spawnMock.mockClear();
  });

  it("passes windowsHide: true in runGit", () => {
    runGit(".", ["status"]);
    expect(spawnSyncMock).toHaveBeenCalled();
    const lastCall = spawnSyncMock.mock.calls[0];
    const opts = lastCall[2] as any;
    expect(opts.windowsHide).toBe(true);
  });

  it("passes windowsHide: true in findRipgrep", () => {
    findRipgrep();
    expect(spawnSyncMock).toHaveBeenCalled();
    const opts = spawnSyncMock.mock.calls[0][2] as any;
    expect(opts.windowsHide).toBe(true);
  });

  it("passes windowsHide: true in findBinary", () => {
    findBinary("some-binary-name-xyz");
    expect(spawnSyncMock).toHaveBeenCalled();
    const opts = spawnSyncMock.mock.calls[0][2] as any;
    expect(opts.windowsHide).toBe(true);
  });

  it("passes windowsHide: true in ProcessCloudflaredAccount.run", async () => {
    const account = new ProcessCloudflaredAccount("fake-cloudflared");
    try {
      await account.listTunnels();
    } catch {}
    expect(spawnSyncMock).toHaveBeenCalled();
    const opts = spawnSyncMock.mock.calls[0][2] as any;
    expect(opts.windowsHide).toBe(true);
  });

  it("passes windowsHide: true in ProcessCloudflaredAccount.login", async () => {
    const account = new ProcessCloudflaredAccount("fake-cloudflared");
    // mock hasCert to return false
    vi.spyOn(account, "hasCert").mockReturnValue(false);
    account.login().catch(() => {});
    expect(spawnMock).toHaveBeenCalled();
    const opts = spawnMock.mock.calls[0][2] as any;
    expect(opts.windowsHide).toBe(true);
  });
});
