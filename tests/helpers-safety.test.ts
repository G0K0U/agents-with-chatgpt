import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanup, git, makeTmpDir, write } from "./helpers.js";

const dirs: string[] = [];
const temp = () => { const dir = makeTmpDir("git-safety"); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) cleanup(dir); });

describe("Git fixture confinement", () => {
  it("refuses a real project path before Git can run", () => {
    expect(() => git(process.cwd(), "status")).toThrow("Unsafe Git fixture path");
  });
  it("refuses parent discovery from an uninitialized fixture", () => {
    expect(() => git(temp(), "add", ".")).toThrow("must own its repository");
  });
  it("refuses a gitfile redirect", () => {
    const dir = temp();
    write(dir, ".git", `gitdir: ${path.join(process.cwd(), ".git")}\n`);
    expect(() => git(dir, "status")).toThrow("Unsafe Git fixture metadata");
  });
  it("refuses a linked repository directory", () => {
    const dir = temp(), target = temp(), link = path.join(dir, "linked");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => git(link, "init")).toThrow("Unsafe Git fixture path");
    expect(fs.existsSync(path.join(target, ".git"))).toBe(false);
  });
});
