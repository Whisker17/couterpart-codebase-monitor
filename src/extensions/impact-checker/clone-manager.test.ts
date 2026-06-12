import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  syncTarget,
  CloneTimeoutError,
  _setGitRunner,
  _resetGitRunner,
  _setDiskChecker,
  _resetDiskChecker,
  _runGitProcess,
  type CloneManagerOptions,
} from "./clone-manager";
import type { MantleTarget } from "../../config/projects";

const TMP_DIR = join(import.meta.dir, "__test-tmp-clone-manager__");

function makeTarget(overrides: Partial<MantleTarget> = {}): MantleTarget {
  return {
    projectId: "test-org/test-repo",
    tags: [],
    repoUrl: "https://github.com/test-org/test-repo",
    branch: "main",
    ...overrides,
  };
}

async function createBareRepo(dir: string): Promise<string> {
  const bareDir = join(dir, "bare.git");
  mkdirSync(bareDir, { recursive: true });
  Bun.spawnSync(["git", "init", "--bare", bareDir]);

  const workDir = join(dir, "work");
  mkdirSync(workDir, { recursive: true });
  Bun.spawnSync(["git", "-c", "init.defaultBranch=main", "init", workDir]);
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: workDir });
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: workDir });
  Bun.spawnSync(["git", "remote", "add", "origin", bareDir], { cwd: workDir });
  writeFileSync(join(workDir, "README.md"), "# Test Repo");
  Bun.spawnSync(["git", "add", "."], { cwd: workDir });
  Bun.spawnSync(["git", "commit", "-m", "initial commit"], { cwd: workDir });
  Bun.spawnSync(["git", "push", "-u", "origin", "main"], { cwd: workDir });

  return bareDir;
}

function makeOpts(clonesDir: string, overrides: Partial<CloneManagerOptions> = {}): CloneManagerOptions {
  return { clonesDir, maxCloneDiskGB: 10, ...overrides };
}

beforeAll(() => {
  mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

afterEach(() => {
  _resetGitRunner();
  _resetDiskChecker();
});

describe("syncTarget — initial clone", () => {
  it("produces a depth-1 single-branch clone on first sync", async () => {
    const testDir = join(TMP_DIR, "initial-clone");
    const clonesDir = join(testDir, "clones");
    const bareRepo = await createBareRepo(testDir);

    // Use local bare repo as repoUrl (projectId drives clone dir name)
    const target = makeTarget({ repoUrl: bareRepo, projectId: "test-org/test-repo", branch: "main" });

    const state = await syncTarget(target, makeOpts(clonesDir));

    const cloneDir = join(clonesDir, "test-org-test-repo");
    expect(state.available).toBe(true);
    expect(state.cloneDir).toBe(cloneDir);
    expect(state.commitHash).toMatch(/^[0-9a-f]{40}$/);
    expect(state.lastFetchAt).toBeTruthy();
    expect(existsSync(join(cloneDir, ".git"))).toBe(true);
  });

  it("uses --branch when branch is specified in args array (no shell concatenation)", async () => {
    const cloneArgs: string[][] = [];
    _setGitRunner(async (args) => {
      cloneArgs.push([...args]);
      if (args[0] === "rev-parse") return "a".repeat(40);
      return "";
    });
    _setDiskChecker(async () => 0);

    const testDir = join(TMP_DIR, "initial-clone-branch");
    mkdirSync(join(testDir, "clones", "test-org-test-repo", ".git"), { recursive: true });
    // Delete .git so it looks like a new target
    rmSync(join(testDir, "clones", "test-org-test-repo"), { recursive: true, force: true });

    const target = makeTarget({ branch: "release" });
    await syncTarget(target, makeOpts(join(testDir, "clones")));

    const cloneCall = cloneArgs.find((a) => a[0] === "clone");
    expect(cloneCall).toBeDefined();
    const branchIdx = cloneCall!.indexOf("--branch");
    expect(branchIdx).not.toBe(-1);
    expect(cloneCall![branchIdx + 1]).toBe("release");
  });
});

describe("syncTarget — repeat sync", () => {
  it("runs fetch + reset on existing clone, does not re-clone", async () => {
    const testDir = join(TMP_DIR, "repeat-sync");
    const clonesDir = join(testDir, "clones");
    const bareRepo = await createBareRepo(testDir);

    const target = makeTarget({ repoUrl: bareRepo, projectId: "test-org/test-repo", branch: "main" });

    // First sync uses real git
    const state1 = await syncTarget(target, makeOpts(clonesDir));
    expect(state1.available).toBe(true);

    // Second sync: track git calls to verify fetch+reset path
    const gitCalls: string[][] = [];
    _setGitRunner(async (args) => {
      gitCalls.push([...args]);
      if (args[0] === "rev-parse") return "b".repeat(40);
      return "";
    });

    const state2 = await syncTarget(target, makeOpts(clonesDir));
    expect(state2.available).toBe(true);
    expect(state2.commitHash).toBe("b".repeat(40));

    expect(gitCalls.some((a) => a[0] === "clone")).toBe(false);
    expect(gitCalls.some((a) => a[0] === "fetch")).toBe(true);
    expect(gitCalls.some((a) => a[0] === "reset")).toBe(true);
  });

  it("passes branch to fetch ref when branch is set", async () => {
    const testDir = join(TMP_DIR, "repeat-sync-branch");
    const clonesDir = join(testDir, "clones");

    // Pre-create fake .git for existing clone path
    const cloneDir = join(clonesDir, "test-org-test-repo");
    mkdirSync(join(cloneDir, ".git"), { recursive: true });

    const fetchCalls: string[][] = [];
    _setGitRunner(async (args) => {
      if (args[0] === "fetch") fetchCalls.push([...args]);
      if (args[0] === "rev-parse") return "c".repeat(40);
      return "";
    });

    const target = makeTarget({ branch: "develop" });
    await syncTarget(target, makeOpts(clonesDir));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("develop");
  });
});

describe("syncTarget — timeout", () => {
  it("marks target unavailable on clone timeout without aborting", async () => {
    const testDir = join(TMP_DIR, "timeout-clone");
    const clonesDir = join(testDir, "clones");
    _setDiskChecker(async () => 0);

    _setGitRunner(async (args) => {
      if (args[0] === "clone") throw new CloneTimeoutError("clone", 120_000);
      return "";
    });

    const state = await syncTarget(makeTarget(), makeOpts(clonesDir));
    expect(state.available).toBe(false);
    expect(state.commitHash).toBe("");
    expect(state.lastFetchAt).toBeTruthy();
  });

  it("marks target unavailable on fetch timeout without aborting", async () => {
    const testDir = join(TMP_DIR, "timeout-fetch");
    const clonesDir = join(testDir, "clones");

    // Pre-create existing clone
    const cloneDir = join(clonesDir, "test-org-test-repo");
    mkdirSync(join(cloneDir, ".git"), { recursive: true });

    _setGitRunner(async (args) => {
      if (args[0] === "fetch") throw new CloneTimeoutError("fetch", 120_000);
      return "";
    });

    const state = await syncTarget(makeTarget(), makeOpts(clonesDir));
    expect(state.available).toBe(false);
    expect(state.commitHash).toBe("");
  });

  it("does not throw for the caller — timeout is contained", async () => {
    const testDir = join(TMP_DIR, "timeout-no-throw");
    const clonesDir = join(testDir, "clones");
    _setDiskChecker(async () => 0);

    _setGitRunner(async (args) => {
      if (args[0] === "clone") throw new CloneTimeoutError("clone", 120_000);
      return "";
    });

    await expect(syncTarget(makeTarget(), makeOpts(clonesDir))).resolves.toBeDefined();
  });
});

describe("syncTarget — disk guardrail", () => {
  it("skips new clone when disk usage exceeds maxCloneDiskGB", async () => {
    const testDir = join(TMP_DIR, "disk-new");
    const clonesDir = join(testDir, "clones");
    mkdirSync(clonesDir, { recursive: true });

    _setDiskChecker(async () => 15); // 15 GB > 10 GB limit

    const gitCalls: string[][] = [];
    _setGitRunner(async (args) => {
      gitCalls.push([...args]);
      return "";
    });

    const state = await syncTarget(makeTarget(), makeOpts(clonesDir));
    expect(state.available).toBe(false);
    expect(gitCalls.some((a) => a[0] === "clone")).toBe(false);
  });

  it("still fetches an existing clone even when disk usage exceeds limit", async () => {
    const testDir = join(TMP_DIR, "disk-existing");
    const clonesDir = join(testDir, "clones");

    // Pre-create existing clone
    const cloneDir = join(clonesDir, "test-org-test-repo");
    mkdirSync(join(cloneDir, ".git"), { recursive: true });

    _setDiskChecker(async () => 15); // Over limit

    const gitCalls: string[][] = [];
    _setGitRunner(async (args) => {
      gitCalls.push([...args]);
      if (args[0] === "rev-parse") return "d".repeat(40);
      return "";
    });

    const state = await syncTarget(makeTarget(), makeOpts(clonesDir));
    expect(state.available).toBe(true);
    expect(state.commitHash).toBe("d".repeat(40));
    expect(gitCalls.some((a) => a[0] === "fetch")).toBe(true);
    expect(gitCalls.some((a) => a[0] === "reset")).toBe(true);
    expect(gitCalls.some((a) => a[0] === "clone")).toBe(false);
  });
});

describe("syncTarget — sync state", () => {
  it("returns commit hash and ISO timestamp after successful sync", async () => {
    const testDir = join(TMP_DIR, "sync-state");
    const clonesDir = join(testDir, "clones");
    const bareRepo = await createBareRepo(testDir);

    const target = makeTarget({ repoUrl: bareRepo, projectId: "test-org/test-repo", branch: "main" });

    const before = new Date();
    const state = await syncTarget(target, makeOpts(clonesDir));
    const after = new Date();

    expect(state.available).toBe(true);
    expect(state.commitHash).toMatch(/^[0-9a-f]{40}$/);

    const fetchAt = new Date(state.lastFetchAt);
    expect(fetchAt >= before).toBe(true);
    expect(fetchAt <= after).toBe(true);
  });

  it("returns cloneDir derived from repoUrl org/repo segments", async () => {
    const testDir = join(TMP_DIR, "sync-clonedir");
    const clonesDir = join(testDir, "clones");

    _setDiskChecker(async () => 0);
    _setGitRunner(async (args) => {
      if (args[0] === "rev-parse") return "e".repeat(40);
      return "";
    });

    const target = makeTarget({ repoUrl: "https://github.com/mantle/reth", projectId: "mantle/reth" });
    const state = await syncTarget(target, makeOpts(clonesDir));

    expect(state.cloneDir).toBe(join(clonesDir, "mantle-reth"));
  });
});
