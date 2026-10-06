import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

describe.skipIf(process.platform !== "win32")("operator-installed ZCode development hook", () => {
  it("allows scoped verification and preserves security denials and plan mode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a2c-hook-"));
    const hook = path.join(root, "hook.mjs");
    fs.copyFileSync(path.resolve("integrations/zcode-development-hook/engineering-ai-permission.mjs"), hook);
    const outputRoot = path.join(root, "provider-exec");
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const document = path.join(root, "approved-backlog.md");
    fs.writeFileSync(document, "ordinary task data");
    fs.writeFileSync(path.join(root, "engineering-ai-permission.json"), JSON.stringify({ schema: 1, workspaceRoot: workspace, executionOutputRoot: outputRoot, readonlyDocuments: [document] }));
    fs.mkdirSync(path.join(workspace, "apps/web"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "apps/web/package.json"), "{}");
    fs.mkdirSync(path.join(workspace, "scripts"));
    fs.writeFileSync(path.join(workspace, "scripts/verify.mjs"), "");
    fs.writeFileSync(path.join(workspace, "scripts/verify.py"), "");
    fs.mkdirSync(path.join(workspace, ".venv/Scripts"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".venv/Scripts/python.exe"), "");
    const { handle } = await import(pathToFileURL(hook).href);
    const request = (command: string, mode = "edit") => ({ cwd: workspace, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command }, mode });
    for (const command of [".venv/Scripts/python.exe --version", ".venv/Scripts/python.exe scripts/verify.py after"]) {
      expect(handle(request(command))).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
      expect(handle(request(command, "plan"))).toBeUndefined();
    }
    for (const command of ["node --version", "pnpm --dir apps/web typecheck", "pnpm --dir apps/web lint", "pnpm -C apps/web test", "node --experimental-strip-types --test apps/web/lib/theme.test.ts", "node scripts/verify.mjs", '".venv/Scripts/python.exe" -m pytest apps/api/tests/test_studies.py -q']) {
      expect(handle(request(command))).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
      expect(handle({ ...request(command), hook_event_name: "PreToolUse" })).toBeUndefined();
      expect(handle(request(command, "plan"))).toBeUndefined();
    }
    for (const command of ["node -e 'process.env'", "pnpm --dir ../outside test", "pnpm --dir apps/web install", "pnpm --dir apps/web test -- --config ../outside", "node --import evil --test apps/web/lib/theme.test.ts", "node --version; whoami", "powershell -Command whoami", "node .env", "python -c 'print(1)'", "git reset --hard"]) {
      expect(handle(request(command))).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    }
    const write = { cwd: workspace, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: path.join(workspace, "AGENTS.md"), content: "bad" } };
    expect(handle(write).hookSpecificOutput.permissionDecision).toBe("deny");
    expect(handle({ ...write, tool_input: { file_path: path.join(workspace, ".env"), content: "bad" } }).hookSpecificOutput.permissionDecision).toBe("deny");
    const session = "sess_11111111-1111-4111-8111-111111111111";
    const other = "sess_22222222-2222-4222-8222-222222222222";
    for (const id of [session, other]) {
      fs.mkdirSync(path.join(outputRoot, id), { recursive: true });
      fs.writeFileSync(path.join(outputRoot, id, "call_1234-stdout.log"), "normal test result");
    }
    const read = { cwd: workspace, session_id: session, hook_event_name: "PermissionRequest", tool_name: "Read", tool_input: { file_path: path.join(outputRoot, session, "call_1234-stdout.log") }, mode: "edit" };
    expect(handle({ ...read, tool_input: { file_path: document } })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect(handle({ ...read, tool_name: "Write", tool_input: { file_path: document } })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    expect(handle(read)).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    const post = { ...read, tool_name: "Bash", toolCallId: "call_1234", hook_event_name: "PostToolUse", tool_input: { command: "pnpm --dir apps/web lint" } };
    expect(handle(post)).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: expect.stringContaining("var/development/command-outputs/") } });
    const projected = path.join(workspace, "var/development/command-outputs", session, "call_1234-stdout.log");
    expect(fs.readFileSync(projected, "utf8")).toBe("normal test result");
    expect(handle(post)).toEqual(handle(post)); // Repeat projection preserves the original artifact.
    expect(handle({ ...post, hook_event_name: "PostToolUseFailure" })).toMatchObject({ hookSpecificOutput: { hookEventName: "PostToolUseFailure" } });
    expect(handle({ ...read, tool_input: { file_path: projected } })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect(handle({ ...read, tool_name: "Grep", tool_input: { path: projected, pattern: "result" } })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "allow" } } });
    expect(handle({ ...post, mode: "plan" })).toBeUndefined();
    expect(handle({ ...post, sessionId: other }).hookSpecificOutput.additionalContext).toContain("PROJECTION_UNAVAILABLE");
    expect(handle({ ...read, tool_input: { file_path: path.join(outputRoot, other, "call_1234-stdout.log") } })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    expect(handle({ ...read, tool_name: "Write" })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    expect(handle({ ...read, sessionId: other })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    expect(handle({ ...read, tool_input: { file_path: path.join(outputRoot, session, "config.json") } })).toMatchObject({ hookSpecificOutput: { decision: { behavior: "deny" } } });
    // Test fixture cleanup is restricted to the verified directory we created.
    expect(path.basename(root)).toMatch(/^a2c-hook-/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
