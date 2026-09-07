import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ENGINEERING_AI_AUDIT_MIRROR_FILENAME,
  ENGINEERING_AI_AUDIT_MIRROR_LOGICAL_PATH,
  ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_TIMELINE_FILENAME,
  ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH,
  ENGINEERING_AI_AUDIT_TIMELINE_LOGICAL_PATH,
  ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
  ENGINEERING_AI_ONEDRIVE_FOLDER,
  ENGINEERING_AI_WORKSPACE_ID,
  MAX_AUDIT_MIRROR_BYTES,
  resolveEngineeringAiAuditMirrorTarget,
  writeEngineeringAiAuditMirror,
} from "../src/execution/audit-mirror.js";
import { readExecutionRecords } from "../src/execution/records.js";
import type { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

describe("Engineering AI OneDrive audit mirror", () => {
  const originalStateDir = process.env.C2C_STATE_DIR;
  const originalConfiguredMirrorRoot = process.env.ENGINEERING_AI_AUDIT_MIRROR_ROOT;
  const originalMirrorRoot = process.env.C2C_ONEDRIVE_ROOT;
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = originalStateDir;
    if (originalConfiguredMirrorRoot === undefined) delete process.env.ENGINEERING_AI_AUDIT_MIRROR_ROOT;
    else process.env.ENGINEERING_AI_AUDIT_MIRROR_ROOT = originalConfiguredMirrorRoot;
    if (originalMirrorRoot === undefined) delete process.env.C2C_ONEDRIVE_ROOT;
    else process.env.C2C_ONEDRIVE_ROOT = originalMirrorRoot;
    for (const directory of temporaryDirectories.splice(0)) cleanup(directory);
  });

  function makeOneDriveRoot(label: string): string {
    const container = makeTmpDir(label);
    temporaryDirectories.push(container);
    const root = path.join(container, ENGINEERING_AI_ONEDRIVE_FOLDER);
    fs.mkdirSync(path.join(root, "Desktop", "Startup"), { recursive: true });
    return fs.realpathSync.native(root);
  }

  function expectMirrorCode(operation: () => unknown, code: string): void {
    let caught: unknown;
    try {
      operation();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code });
  }

  it("allows only the fixed mirror and returns hashed evidence plus an audit record", async () => {
    isolateStateDir();
    const root = makeOneDriveRoot("audit-mirror-allow");
    const workspaceId = "abcdef123456";
    const content = "# Engineering AI audit status\n\nPASS\n";

    const evidence = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      content,
      recordWorkspaceId: workspaceId,
      taskId: "c2c_auditmirror1",
    });

    const target = path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME);
    expect(evidence).toMatchObject({
      success: true,
      code: "OK",
      logicalTarget: ENGINEERING_AI_AUDIT_MIRROR_LOGICAL_PATH,
      resolvedTarget: target,
      byteCount: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      source: "payload",
    });
    expect(fs.readFileSync(target, "utf8")).toBe(content);

    const record = readExecutionRecords(workspaceId, 5).at(-1);
    expect(record).toMatchObject({
      taskId: "c2c_auditmirror1",
      exitStatus: "ok",
      auditMirror: {
        logicalTarget: ENGINEERING_AI_AUDIT_MIRROR_LOGICAL_PATH,
        resolvedTarget: target,
        success: true,
        code: "OK",
        byteCount: Buffer.byteLength(content, "utf8"),
      },
    });

    const updatedContent = "# Engineering AI audit status\n\nUPDATED\n";
    const updated = await writeEngineeringAiAuditMirror({ oneDriveRoot: root, content: updatedContent });
    expect(updated).toMatchObject({ success: true, code: "OK", targetFilename: ENGINEERING_AI_AUDIT_MIRROR_FILENAME });
    expect(fs.readFileSync(target, "utf8")).toBe(updatedContent);
  });

  it("denies siblings, alternate names, traversal, absolute paths, and home-like roots", () => {
    const root = makeOneDriveRoot("audit-mirror-deny");
    const outside = makeTmpDir("audit-mirror-outside");
    temporaryDirectories.push(outside);
    const denied = [
      "Desktop/Startup/other-status.md",
      "Desktop/Startup/engineering-ai-audit-status.txt",
      "Desktop/Startup/../engineering-ai-audit-status.md",
      "..\\outside\\engineering-ai-audit-status.md",
      path.join(outside, ENGINEERING_AI_AUDIT_MIRROR_FILENAME),
    ];

    for (const requestedPath of denied) {
      expectMirrorCode(() => resolveEngineeringAiAuditMirrorTarget({ oneDriveRoot: root, requestedPath }), "MIRROR_TARGET_DENIED");
    }

    const homeLike = makeTmpDir("home-like");
    temporaryDirectories.push(homeLike);
    fs.mkdirSync(path.join(homeLike, "Desktop", "Startup"), { recursive: true });
    expectMirrorCode(() => resolveEngineeringAiAuditMirrorTarget({ oneDriveRoot: homeLike }), "ONEDRIVE_ROOT_INVALID");
  });

  it("denies a directory junction or symlink that escapes the mirror root", () => {
    const root = makeOneDriveRoot("audit-mirror-link");
    const outside = makeTmpDir("audit-mirror-link-outside");
    temporaryDirectories.push(outside);
    const startup = path.join(root, "Desktop", "Startup");
    fs.rmSync(startup, { recursive: true, force: true });
    try {
      fs.symlinkSync(outside, startup, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      throw new Error(`The focused reparse-point test could not create its link: ${String(error)}`);
    }

    expectMirrorCode(() => resolveEngineeringAiAuditMirrorTarget({ oneDriveRoot: root }), "MIRROR_REPARSE_POINT");
  });

  it("denies a target symlink or junction even when its destination is outside the root", () => {
    const root = makeOneDriveRoot("audit-mirror-target-link");
    const outside = makeTmpDir("audit-mirror-target-outside");
    temporaryDirectories.push(outside);
    const target = path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME);
    try {
      fs.symlinkSync(outside, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      throw new Error(`The focused reparse-point test could not create its link: ${String(error)}`);
    }

    expectMirrorCode(() => resolveEngineeringAiAuditMirrorTarget({ oneDriveRoot: root }), "MIRROR_REPARSE_POINT");
  });

  it("maps different machine-local OneDrive roots to the same logical relative target", () => {
    const firstRoot = makeOneDriveRoot("audit-mirror-machine-a");
    const secondRoot = makeOneDriveRoot("audit-mirror-machine-b");
    const first = resolveEngineeringAiAuditMirrorTarget({ oneDriveRoot: firstRoot });
    const second = resolveEngineeringAiAuditMirrorTarget({
      oneDriveRoot: secondRoot,
      requestedPath: `${ENGINEERING_AI_ONEDRIVE_FOLDER}\\${ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH.replace(/\//g, "\\")}`,
    });

    expect(first.relativePath).toBe(ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH);
    expect(second.relativePath).toBe(first.relativePath);
    expect(second.logicalPath).toBe(first.logicalPath);
    expect(second.target).not.toBe(first.target);
  });

  it("resolves the configured C2C or standard OneDrive environment root without a home fallback", () => {
    const root = makeOneDriveRoot("audit-mirror-env");
    process.env.ENGINEERING_AI_AUDIT_MIRROR_ROOT = root;
    expect(resolveEngineeringAiAuditMirrorTarget().target).toBe(
      path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME)
    );

    delete process.env.ENGINEERING_AI_AUDIT_MIRROR_ROOT;
    process.env.C2C_ONEDRIVE_ROOT = root;
    expect(resolveEngineeringAiAuditMirrorTarget().target).toBe(
      path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME)
    );

    delete process.env.C2C_ONEDRIVE_ROOT;
    const standard = resolveEngineeringAiAuditMirrorTarget({
      environment: { OneDriveCommercial: root },
      discoveryRoots: [],
    });
    expect(standard.relativePath).toBe(ENGINEERING_AI_AUDIT_MIRROR_RELATIVE_PATH);
  });

  it("discovers the exact named OneDrive account in a bounded configured search root", () => {
    const container = makeTmpDir("audit-mirror-discovery");
    temporaryDirectories.push(container);
    const holder = path.join(container, "Onedrive-TestAccount");
    const root = path.join(holder, ENGINEERING_AI_ONEDRIVE_FOLDER);
    fs.mkdirSync(path.join(root, "Desktop", "Startup"), { recursive: true });

    const resolved = resolveEngineeringAiAuditMirrorTarget({
      environment: {},
      discoveryRoots: [container],
    });

    expect(resolved.oneDriveRoot).toBe(fs.realpathSync.native(root));
    expect(resolved.target).toBe(path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME));
  });

  it("reads the matching fixed ledger path for status and timeline", async () => {
    const root = makeOneDriveRoot("audit-mirror-ledger");
    const statusContent = "# Canonical status ledger\n\nSTATUS\n";
    const timelineContent = "# Canonical timeline ledger\n\nTIMELINE\n";
    const readFile = vi.fn(async (requestedPath: string) => ({
      path: requestedPath,
      sizeBytes: Buffer.byteLength(requestedPath === ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH ? statusContent : timelineContent, "utf8"),
      totalLines: 3,
      startLine: 1,
      endLine: 3,
      truncated: false,
      remainingLines: 0,
      nextStartLine: null,
      content: requestedPath === ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH ? statusContent : timelineContent,
    }));
    const ledgerWorkspace = { id: ENGINEERING_AI_WORKSPACE_ID, readFile } as unknown as Workspace;

    const status = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      source: "engineering_ai_ledger",
      ledgerWorkspace,
    });
    const timeline = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      requestedPath: ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
      source: "engineering_ai_ledger",
      ledgerWorkspace,
    });

    expect(status).toMatchObject({ success: true, code: "OK", source: "engineering_ai_ledger", targetFilename: ENGINEERING_AI_AUDIT_MIRROR_FILENAME });
    expect(timeline).toMatchObject({ success: true, code: "OK", source: "engineering_ai_ledger", targetFilename: ENGINEERING_AI_AUDIT_TIMELINE_FILENAME });
    expect(readFile).toHaveBeenNthCalledWith(1, ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH, expect.any(Object));
    expect(readFile).toHaveBeenNthCalledWith(2, ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH, expect.any(Object));
    expect(fs.readFileSync(path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME), "utf8")).toBe(statusContent);
    expect(fs.readFileSync(path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_TIMELINE_FILENAME), "utf8")).toBe(timelineContent);
  });

  it("preserves the canonical ledger bytes when a real workspace resolver is available", async () => {
    const root = makeOneDriveRoot("audit-mirror-byte-exact");
    const sourceRoot = makeTmpDir("audit-mirror-byte-exact-source");
    temporaryDirectories.push(sourceRoot);
    const statusPath = path.join(sourceRoot, ENGINEERING_AI_AUDIT_STATUS_LEDGER_RELATIVE_PATH);
    const timelinePath = path.join(sourceRoot, ENGINEERING_AI_AUDIT_TIMELINE_LEDGER_RELATIVE_PATH);
    fs.mkdirSync(path.dirname(statusPath), { recursive: true });
    const statusBytes = Buffer.from("# status\r\n\r\nSTATUS\r\n", "utf8");
    const timelineBytes = Buffer.from("# timeline\r\n\r\nTIMELINE\r\n", "utf8");
    fs.writeFileSync(statusPath, statusBytes);
    fs.writeFileSync(timelinePath, timelineBytes);
    const ledgerWorkspace = {
      id: ENGINEERING_AI_WORKSPACE_ID,
      resolve: (requested: string) => ({
        abs: path.join(sourceRoot, requested),
        rel: requested,
      }),
    } as unknown as Workspace;

    await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      source: "engineering_ai_ledger",
      ledgerWorkspace,
    });
    await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      requestedPath: ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
      source: "engineering_ai_ledger",
      ledgerWorkspace,
    });

    expect(fs.readFileSync(path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_MIRROR_FILENAME))).toEqual(statusBytes);
    expect(fs.readFileSync(path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_TIMELINE_FILENAME))).toEqual(timelineBytes);
  });

  it("never reports a timeline request as status when the root is missing", async () => {
    const ledgerWorkspace = { id: ENGINEERING_AI_WORKSPACE_ID } as unknown as Workspace;
    const evidence = await writeEngineeringAiAuditMirror({
      environment: {},
      discoveryRoots: [],
      requestedPath: ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
      source: "engineering_ai_ledger",
      ledgerWorkspace,
    });

    expect(evidence).toMatchObject({
      success: false,
      code: "ONEDRIVE_ROOT_NOT_CONFIGURED",
      logicalTarget: ENGINEERING_AI_AUDIT_TIMELINE_LOGICAL_PATH,
      targetFilename: ENGINEERING_AI_AUDIT_TIMELINE_FILENAME,
      resolvedTarget: null,
    });
  });

  it("supports the second fixed timeline target and reports stale mirror evidence", async () => {
    const root = makeOneDriveRoot("audit-mirror-timeline");
    const timeline = "# Canonical Engineering AI timeline\n\nPASS\n";
    const target = path.join(root, "Desktop", "Startup", ENGINEERING_AI_AUDIT_TIMELINE_FILENAME);

    const first = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      requestedPath: ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH,
      content: timeline,
    });
    expect(first).toMatchObject({
      success: true,
      targetFilename: ENGINEERING_AI_AUDIT_TIMELINE_FILENAME,
      logicalTarget: ENGINEERING_AI_AUDIT_TIMELINE_LOGICAL_PATH,
      freshness: "fresh",
      lastSuccessSha256: createHash("sha256").update(timeline, "utf8").digest("hex"),
    });
    expect(fs.readFileSync(target, "utf8")).toBe(timeline);

    fs.writeFileSync(target, "# changed outside the mirror writer\n");
    const unavailableLedger = { id: ENGINEERING_AI_WORKSPACE_ID, readFile: vi.fn(async () => { throw new Error("unavailable"); }) } as unknown as Workspace;
    const stale = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      requestedPath: `${ENGINEERING_AI_ONEDRIVE_FOLDER}/${ENGINEERING_AI_AUDIT_TIMELINE_RELATIVE_PATH}`,
      source: "engineering_ai_ledger",
      ledgerWorkspace: unavailableLedger,
    });
    expect(stale).toMatchObject({
      success: false,
      code: "ENGINEERING_AI_LEDGER_UNAVAILABLE",
      targetFilename: ENGINEERING_AI_AUDIT_TIMELINE_FILENAME,
      freshness: "stale",
      lastSuccessAtUtc: expect.any(String),
      lastSuccessSha256: createHash("sha256").update(timeline, "utf8").digest("hex"),
    });
  });

  it("rejects oversized payloads and never falls back to a generic ledger path", async () => {
    const root = makeOneDriveRoot("audit-mirror-source");
    const tooLarge = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      content: "x".repeat(MAX_AUDIT_MIRROR_BYTES + 1),
    });
    expect(tooLarge).toMatchObject({ success: false, code: "SOURCE_TOO_LARGE" });

    const missingAuthorization = await writeEngineeringAiAuditMirror({
      oneDriveRoot: root,
      source: "engineering_ai_ledger",
    });
    expect(missingAuthorization).toMatchObject({
      success: false,
      code: "ENGINEERING_AI_WORKSPACE_NOT_AUTHORIZED",
    });
  });
});
