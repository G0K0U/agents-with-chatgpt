import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn } from "node:child_process";
import path from "node:path";
import {
  CodexAppServerClient,
  CodexExecutableResolutionError,
  resolveCodexExecutable,
  type AppServerClient,
} from "../src/execution/app-server.js";
import { CodexTaskManager } from "../src/execution/tasks.js";
import { nullLogger } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

const windowsExecutable = String.raw`C:\Tools\Codex\codex.exe`;

function resolutionError(run: () => unknown): CodexExecutableResolutionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CodexExecutableResolutionError);
    return error as CodexExecutableResolutionError;
  }
  throw new Error("Expected executable resolution to fail");
}

describe("Codex App Server executable resolution", () => {
  it("uses a validated absolute override before installation discovery", () => {
    const checked: string[] = [];
    const result = resolveCodexExecutable({
      env: { C2C_CODEX_EXECUTABLE: windowsExecutable, CODEX_MANAGED_PACKAGE_ROOT: String.raw`C:\ignored` },
      platform: "win32",
      arch: "x64",
      execPath: String.raw`C:\Node\node.exe`,
      modulePath: String.raw`C:\C2C\dist\execution\app-server.js`,
      isFile: (candidate) => {
        checked.push(candidate);
        return candidate === windowsExecutable;
      },
    });

    expect(result).toBe(windowsExecutable);
    expect(checked).toEqual([windowsExecutable]);
  });

  it("rejects relative and missing overrides without falling back to discovery", () => {
    const relative = resolutionError(() =>
      resolveCodexExecutable({
        env: { C2C_CODEX_EXECUTABLE: "codex.exe" },
        platform: "win32",
        isFile: () => true,
      })
    );
    expect(relative.code).toBe("CODEX_EXECUTABLE_OVERRIDE_INVALID");

    const missingPath = String.raw`C:\private\missing\codex.exe`;
    const missing = resolutionError(() =>
      resolveCodexExecutable({
        env: { C2C_CODEX_EXECUTABLE: missingPath },
        platform: "win32",
        isFile: () => false,
      })
    );
    expect(missing.code).toBe("CODEX_EXECUTABLE_OVERRIDE_INVALID");
    expect(missing.message).not.toContain(missingPath);
  });

  it.each(["codex.cmd", "codex.bat"])("rejects the Windows script override %s", (name) => {
    const override = `C:\\Tools\\${name}`;
    const error = resolutionError(() =>
      resolveCodexExecutable({
        env: { C2C_CODEX_EXECUTABLE: override },
        platform: "win32",
        isFile: () => true,
      })
    );

    expect(error.code).toBe("CODEX_EXECUTABLE_OVERRIDE_INVALID");
    expect(error.message).toContain("native .exe");
    expect(error.message).not.toContain(override);
  });

  it("discovers the native executable in the official Windows platform package", () => {
    const packageRoot = String.raw`C:\Node\node_modules\@openai\codex`;
    const expected = path.win32.join(
      packageRoot,
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe"
    );

    expect(
      resolveCodexExecutable({
        env: { CODEX_MANAGED_PACKAGE_ROOT: packageRoot },
        platform: "win32",
        arch: "x64",
        execPath: String.raw`C:\elsewhere\node.exe`,
        modulePath: String.raw`D:\c2c\dist\execution\app-server.js`,
        isFile: (candidate) => candidate === expected,
      })
    ).toBe(expected);
  });

  it("returns a sanitized typed error when Windows discovery finds no native executable", () => {
    const privateRoot = String.raw`C:\Users\private-user\node_modules\@openai\codex`;
    const error = resolutionError(() =>
      resolveCodexExecutable({
        env: { CODEX_MANAGED_PACKAGE_ROOT: privateRoot },
        platform: "win32",
        arch: "x64",
        execPath: String.raw`C:\Node\node.exe`,
        modulePath: String.raw`D:\c2c\dist\execution\app-server.js`,
        isFile: () => false,
      })
    );

    expect(error.code).toBe("CODEX_EXECUTABLE_NOT_FOUND");
    expect(error.message).not.toContain(privateRoot);
  });

  it("keeps non-Windows default resolution while honoring a valid override", () => {
    expect(resolveCodexExecutable({ env: {}, platform: "linux" })).toBe("codex");
    expect(
      resolveCodexExecutable({
        env: { C2C_CODEX_EXECUTABLE: "/opt/codex/bin/codex" },
        platform: "linux",
        isFile: () => true,
      })
    ).toBe("/opt/codex/bin/codex");
  });
});

describe("Codex App Server launcher", () => {
  it("spawns the resolved executable directly with shell disabled", async () => {
    const spawnImpl = vi.fn(() => {
      throw new Error("test spawn stop");
    }) as unknown as typeof spawn;
    const client = new CodexAppServerClient(
      { workspaceRoot: String.raw`C:\workspace`, logger: nullLogger },
      { resolveExecutable: () => windowsExecutable, spawn: spawnImpl }
    );

    await expect(client.initialize()).rejects.toThrow("Unable to start the Codex App Server");
    expect(spawnImpl).toHaveBeenCalledOnce();
    const [command, args, options] = spawnImpl.mock.calls[0];
    expect(command).toBe(windowsExecutable);
    expect(args).toEqual(expect.arrayContaining(["app-server", "--stdio"]));
    expect(options).toMatchObject({ shell: false, windowsHide: true });
  });
});

describe("Codex task launcher failure mapping", () => {
  let root: string | undefined;
  let manager: CodexTaskManager | undefined;

  afterEach(async () => {
    await manager?.close();
    if (root) cleanup(root);
  });

  it("persists executable resolution failures distinctly from generic unavailability", async () => {
    isolateStateDir();
    root = makeTmpDir("launcher-resolution");
    makeGitRepo(root);
    const workspace = new Workspace(root);
    const unavailableClient: AppServerClient = {
      initialize: async () => {
        throw new CodexExecutableResolutionError(
          "CODEX_EXECUTABLE_NOT_FOUND",
          "No native Codex executable was found in the installed Codex package"
        );
      },
      request: async () => ({}),
      notify: () => undefined,
      setNotificationHandler: () => undefined,
      setRequestHandler: () => undefined,
      respond: () => undefined,
      respondError: () => undefined,
      close: async () => undefined,
    };
    manager = new CodexTaskManager(workspace, {
      appServerFactory: () => unavailableClient,
      fullAccess: true,
    });

    const submitted = manager.submit({
      workspace_id: workspace.id,
      instruction: "Exercise the fixed App Server launcher.",
      write_scope: ["."],
      network: false,
      run_tests: false,
    });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = manager.get(submitted.taskId);
      if (result.status === "failed") {
        expect(result.error).toEqual({
          code: "CODEX_EXECUTABLE_NOT_FOUND",
          message: "No native Codex executable was found in the installed Codex package",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Task did not reach the expected launcher failure");
  });
});


describe("native offline full-access limitation", () => {
  it.each([false, undefined])("rejects network=%s before executable resolution or spawn", async networkAccess => {
    const resolveExecutable = vi.fn(() => windowsExecutable);
    const spawnChild = vi.fn();
    const client = new CodexAppServerClient({ workspaceRoot: process.cwd(), logger: nullLogger, fullAccess: true, networkAccess },
      { resolveExecutable, spawn: spawnChild as unknown as typeof spawn });
    await expect(client.initialize()).rejects.toThrow("NETWORK_POLICY_UNSUPPORTED");
    expect(resolveExecutable).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
  });
});
