import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync } from "fs";
import { join } from "path";
import { makeAgentTools, _setRgRunner, _resetRgRunner, fencePathToCloneDir } from "./agent-tools";

const TMP_DIR = join(import.meta.dir, "__test-tmp-agent-tools__");
const CLONE_DIR = join(TMP_DIR, "clone");

beforeAll(() => {
  mkdirSync(CLONE_DIR, { recursive: true });
  // Set up some test files
  writeFileSync(join(CLONE_DIR, "main.ts"), "function vulnerableFunc() {\n  return doSomethingDangerous();\n}\n");
  mkdirSync(join(CLONE_DIR, "src"), { recursive: true });
  writeFileSync(join(CLONE_DIR, "src", "index.ts"), Array(300).fill("line content here").join("\n"));
  writeFileSync(join(CLONE_DIR, "src", "large.ts"), "a".repeat(9000));
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  _resetRgRunner();
});

// ─── Path fencing tests ───────────────────────────────────────────────────────

describe("fencePathToCloneDir", () => {
  it("allows relative path within clone dir", () => {
    const result = fencePathToCloneDir("src/index.ts", CLONE_DIR);
    expect(result).not.toBeNull();
    expect(result!.startsWith(CLONE_DIR)).toBe(true);
  });

  it("rejects .. traversal attempt", () => {
    const result = fencePathToCloneDir("../etc/passwd", CLONE_DIR);
    expect(result).toBeNull();
  });

  it("rejects deep .. traversal", () => {
    const result = fencePathToCloneDir("src/../../etc/passwd", CLONE_DIR);
    expect(result).toBeNull();
  });

  it("rejects absolute path outside clone dir", () => {
    const result = fencePathToCloneDir("/etc/passwd", CLONE_DIR);
    expect(result).toBeNull();
  });

  it("allows absolute path inside clone dir", () => {
    const absPath = join(CLONE_DIR, "main.ts");
    const result = fencePathToCloneDir(absPath, CLONE_DIR);
    expect(result).not.toBeNull();
  });

  it("rejects symlink escaping clone dir", () => {
    const symlinkPath = join(CLONE_DIR, "escape_link");
    if (!existsSync(symlinkPath)) {
      symlinkSync("/tmp", symlinkPath);
    }
    const result = fencePathToCloneDir("escape_link/some_file", CLONE_DIR);
    // Should be null because resolved path points outside clone
    expect(result).toBeNull();
  });
});

// ─── read_file tool tests ─────────────────────────────────────────────────────

describe("read_file tool", () => {
  it("returns file content for valid path", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "main.ts" }, {} as any);
    expect(result.content).toContain("vulnerableFunc");
    expect(result.error).toBeUndefined();
  });

  it("rejects .. path escape", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "../etc/passwd" }, {} as any);
    expect(result.error).toContain("outside the clone directory");
  });

  it("rejects absolute path outside clone", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "/etc/passwd" }, {} as any);
    expect(result.error).toContain("outside the clone directory");
  });

  it("returns error for nonexistent file", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "nonexistent.ts" }, {} as any);
    expect(result.error).toContain("not found");
  });

  it("respects 250-line cap", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "src/index.ts" }, {} as any);
    // File has 299 lines; should cap at 250
    const lines = result.content.split("\n").filter((l: string) => /^\d+:/.test(l));
    expect(lines.length).toBeLessThanOrEqual(250);
    expect(result.content).toContain("[truncated");
  });

  it("respects line range: start_line and end_line", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "main.ts", start_line: 2, end_line: 2 }, {} as any);
    expect(result.content).toContain("2:");
    expect(result.content).toContain("doSomethingDangerous");
  });

  it("caps output at 8KB", async () => {
    const { read_file } = makeAgentTools(CLONE_DIR);
    const result = await (read_file.execute as Function)({ path: "src/large.ts" }, {} as any);
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(8 * 1024 + 200); // some slack for truncation notice
    expect(result.content).toContain("[truncated");
  });
});

// ─── grep_repo tool tests ─────────────────────────────────────────────────────

describe("grep_repo tool", () => {
  it("rejects .. path escape", async () => {
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)({ pattern: "test", path: "../etc" }, {} as any);
    expect(result.error).toContain("outside the clone directory");
  });

  it("rejects absolute path outside clone", async () => {
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)({ pattern: "test", path: "/etc/passwd" }, {} as any);
    expect(result.error).toContain("outside the clone directory");
  });

  it("returns tool error on rg timeout (not a thrown exception)", async () => {
    _setRgRunner(async (_args, _timeoutMs) => {
      return { stdout: "", stderr: "", exitCode: 1, timedOut: true };
    });
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)({ pattern: "anything" }, {} as any);
    expect(result.error).toContain("timed out");
    // Key: it did NOT throw — result has error field
  });

  it("respects 50-match limit via --max-count arg", async () => {
    const capturedArgs: string[][] = [];
    _setRgRunner(async (args) => {
      capturedArgs.push(args);
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    });
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    await (grep_repo.execute as Function)({ pattern: "func" }, {} as any);
    const maxCountIdx = capturedArgs[0]?.indexOf("--max-count");
    expect(maxCountIdx).not.toBe(-1);
    expect(capturedArgs[0]?.[maxCountIdx! + 1]).toBe("50");
  });

  it("caps output at 8KB/200 lines with truncation notice", async () => {
    const bigOutput = Array(300).fill("src/main.ts:1:some match content here").join("\n");
    _setRgRunner(async () => ({
      stdout: bigOutput,
      stderr: "",
      exitCode: 0,
      timedOut: false,
    }));
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)({ pattern: "func" }, {} as any);
    expect(result.matches).toContain("[truncated");
    const outputBytes = Buffer.byteLength(result.matches, "utf8");
    expect(outputBytes).toBeLessThanOrEqual(8 * 1024 + 300); // truncation notice adds some bytes
  });

  it("excludes .codegraph by default", async () => {
    const capturedArgs: string[][] = [];
    _setRgRunner(async (args) => {
      capturedArgs.push(args);
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    });
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    await (grep_repo.execute as Function)({ pattern: "test" }, {} as any);
    expect(capturedArgs[0]).toContain("!.codegraph");
  });

  it("returns no matches notice on empty output", async () => {
    _setRgRunner(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
      timedOut: false,
    }));
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)({ pattern: "zzznomatch" }, {} as any);
    expect(result.notice).toContain("No matches found");
  });

  it("returns error on rg non-zero non-one exit code", async () => {
    _setRgRunner(async () => ({
      stdout: "",
      stderr: "rg: some error",
      exitCode: 2,
      timedOut: false,
    }));
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)({ pattern: "test" }, {} as any);
    expect(result.error).toContain("grep_repo failed");
  });

  it("passes allowlisted flags to rg", async () => {
    const capturedArgs: string[][] = [];
    _setRgRunner(async (args) => {
      capturedArgs.push(args);
      return { stdout: "match", stderr: "", exitCode: 0, timedOut: false };
    });
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)(
      { pattern: "test", flags: ["-i", "-w"] },
      {} as any
    );
    expect(result.error).toBeUndefined();
    expect(capturedArgs[0]).toContain("-i");
    expect(capturedArgs[0]).toContain("-w");
  });

  it("passes pattern via --regexp so flag-like patterns are not parsed as options", async () => {
    const capturedArgs: string[][] = [];
    _setRgRunner(async (args) => {
      capturedArgs.push(args);
      return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
    });
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    // A pattern that looks like an rg option — must NOT enable preprocessor
    await (grep_repo.execute as Function)({ pattern: "--pre=sh" }, {} as any);
    const regexpIdx = capturedArgs[0]?.indexOf("--regexp");
    // --regexp must appear and be immediately followed by the raw pattern value
    expect(regexpIdx).not.toBe(-1);
    expect(capturedArgs[0]?.[regexpIdx! + 1]).toBe("--pre=sh");
    // The pattern must NOT appear as a bare argv element (which rg would parse as an option)
    const bareIdx = capturedArgs[0]?.findIndex(
      (a, i) => a === "--pre=sh" && i !== regexpIdx! + 1
    );
    expect(bareIdx).toBe(-1);
  });

  it("rejects disallowed flags (e.g. --pre) without calling rg", async () => {
    let rgCalled = false;
    _setRgRunner(async () => {
      rgCalled = true;
      return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
    });
    const { grep_repo } = makeAgentTools(CLONE_DIR);
    const result = await (grep_repo.execute as Function)(
      { pattern: "test", flags: ["--pre", "/usr/bin/evil"] },
      {} as any
    );
    expect(result.error).toContain("Flag not allowed");
    expect(result.error).toContain("--pre");
    expect(rgCalled).toBe(false);
  });
});
