import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { MantleTarget } from "../../config/projects";

export const CLONE_TIMEOUT_MS = 120_000;

export class CloneTimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly timeoutMs: number
  ) {
    super(
      `git ${operation} timed out after ${timeoutMs}ms — marking target unavailable this run`
    );
    this.name = "CloneTimeoutError";
  }
}

export interface CloneSyncState {
  lastFetchAt: string; // ISO 8601
  commitHash: string;
  available: boolean;
  cloneDir: string;
}

export interface CloneManagerOptions {
  clonesDir: string;
  maxCloneDiskGB: number;
  timeoutMs?: number;
  // Phase 2 stub — codegraph indexing is out of scope for this release
  onCloneReady?: (cloneDir: string, commitHash: string) => Promise<void>;
}

// Exported for testing — override subprocess execution and disk checks
export type GitRunner = (args: string[], cwd?: string, timeoutMs?: number) => Promise<string>;
export type DiskChecker = (dir: string) => Promise<number>;

let _gitRunner: GitRunner | null = null;
let _diskChecker: DiskChecker | null = null;

export function _setGitRunner(runner: GitRunner): void {
  _gitRunner = runner;
}

export function _resetGitRunner(): void {
  _gitRunner = null;
}

export function _setDiskChecker(checker: DiskChecker): void {
  _diskChecker = checker;
}

export function _resetDiskChecker(): void {
  _diskChecker = null;
}

export async function _runGitProcess(
  args: string[],
  cwd?: string,
  timeoutMs?: number
): Promise<string> {
  let timedOut = false;
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);
  }

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (timedOut) {
    throw new CloneTimeoutError(args[0] ?? "operation", timeoutMs ?? 0);
  }

  if (exitCode !== 0) {
    throw new Error(
      `git ${args[0] ?? "operation"} failed (exit ${exitCode}): ${stderr.trim()}`
    );
  }

  return stdout.trim();
}

async function defaultDiskChecker(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  try {
    const proc = Bun.spawnSync(["du", "-sk", dir], { stderr: "pipe" });
    if (proc.exitCode !== 0) return 0;
    const output = new TextDecoder().decode(proc.stdout).trim();
    const kb = parseInt(output.split("\t")[0] ?? "0", 10);
    return isNaN(kb) ? 0 : kb / (1024 * 1024);
  } catch {
    return 0;
  }
}

function getRunGit(): GitRunner {
  return _gitRunner ?? _runGitProcess;
}

function getDiskCheckerFn(): DiskChecker {
  return _diskChecker ?? defaultDiskChecker;
}

function cloneDirForTarget(target: MantleTarget, clonesDir: string): string {
  const { repoUrl, projectId } = target;
  if (!repoUrl) {
    throw new Error(`MantleTarget ${projectId} has no repoUrl — cannot determine clone directory`);
  }

  try {
    const urlObj = new URL(repoUrl);
    const segments = urlObj.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      const org = segments[0]!;
      const repo = segments[1]!;
      return join(clonesDir, `${org}-${repo}`);
    }
  } catch {
    // Not a valid URL (e.g. local path in tests) — fall through to projectId-based naming
  }

  // Fallback: derive from projectId ("org/repo" → "org-repo")
  const slug = projectId.replace(/\//g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
  return join(clonesDir, slug);
}

export async function syncTarget(
  target: MantleTarget,
  opts: CloneManagerOptions
): Promise<CloneSyncState> {
  const { clonesDir, maxCloneDiskGB } = opts;
  const timeoutMs = opts.timeoutMs ?? CLONE_TIMEOUT_MS;
  const runGit = getRunGit();
  const checkDisk = getDiskCheckerFn();

  if (!target.repoUrl) {
    throw new Error(`MantleTarget ${target.projectId} has no repoUrl — cannot sync`);
  }

  const cloneDir = cloneDirForTarget(target, clonesDir);
  const branch = target.branch;
  const alreadyCloned = existsSync(join(cloneDir, ".git"));

  if (!alreadyCloned) {
    const diskUsageGB = await checkDisk(clonesDir);
    if (diskUsageGB > maxCloneDiskGB) {
      console.warn(
        `[clone-manager] Disk usage ${diskUsageGB.toFixed(2)}GB exceeds ${maxCloneDiskGB}GB limit` +
          ` — skipping new clone of ${target.projectId}`
      );
      return {
        lastFetchAt: new Date().toISOString(),
        commitHash: "",
        available: false,
        cloneDir,
      };
    }

    try {
      mkdirSync(dirname(cloneDir), { recursive: true });
      const cloneArgs = ["clone", "--depth", "1", "--single-branch"];
      if (branch) cloneArgs.push("--branch", branch);
      cloneArgs.push(target.repoUrl, cloneDir);
      await runGit(cloneArgs, undefined, timeoutMs);
    } catch (err) {
      if (err instanceof CloneTimeoutError) {
        console.warn(`[clone-manager] ${err.message}`);
        return {
          lastFetchAt: new Date().toISOString(),
          commitHash: "",
          available: false,
          cloneDir,
        };
      }
      throw err;
    }
  } else {
    try {
      const fetchRef = branch ?? "HEAD";
      await runGit(["fetch", "--depth", "1", "origin", fetchRef], cloneDir, timeoutMs);
      await runGit(["reset", "--hard", "FETCH_HEAD"], cloneDir);
    } catch (err) {
      if (err instanceof CloneTimeoutError) {
        console.warn(`[clone-manager] ${err.message}`);
        return {
          lastFetchAt: new Date().toISOString(),
          commitHash: "",
          available: false,
          cloneDir,
        };
      }
      throw err;
    }
  }

  const commitHash = await runGit(["rev-parse", "HEAD"], cloneDir);
  const lastFetchAt = new Date().toISOString();

  const diskUsageGB = await checkDisk(clonesDir);
  if (diskUsageGB > maxCloneDiskGB) {
    console.warn(
      `[clone-manager] Post-sync disk usage ${diskUsageGB.toFixed(2)}GB exceeds ${maxCloneDiskGB}GB limit` +
        ` — future new clones will be skipped`
    );
  }

  return {
    lastFetchAt,
    commitHash,
    available: true,
    cloneDir,
  };
}
