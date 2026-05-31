import { Octokit } from "octokit";
import { RequestError } from "@octokit/request-error";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getSettings } from "../../config/settings";
import { RepoNotFoundError } from "./fetcher";

const MAX_DIFF_BYTES = 2_000_000;

export type DiffStatus = "available" | "fetch_failed" | "too_large";

export interface DiffResult {
  status: DiffStatus;
  path: string | null;
}

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (_octokit) return _octokit;
  const { github } = getSettings();
  _octokit = new Octokit({ auth: github.token });
  return _octokit;
}

function isRateLimitExhausted(err: RequestError): boolean {
  return err.status === 403 && err.response?.headers["x-ratelimit-remaining"] === "0";
}

async function waitForRateLimitReset(err: RequestError): Promise<void> {
  const resetHeader = err.response?.headers["x-ratelimit-reset"];
  const resetTimestamp = resetHeader ? parseInt(String(resetHeader), 10) : 0;
  const waitMs = Math.max(0, resetTimestamp * 1000 - Date.now()) + 1_000; // 1s buffer
  console.warn(`[GitHub] Rate limited (403). Waiting ${Math.ceil(waitMs / 1000)}s until reset...`);
  await new Promise((r) => setTimeout(r, waitMs));
}

const MAX_DIFF_RETRIES = 3;

async function fetchDiffWithRetry(octokit: Octokit, org: string, repo: string, prNumber: number): Promise<string> {
  let lastError: Error = new Error("unreachable");

  for (let attempt = 0; attempt <= MAX_DIFF_RETRIES; attempt++) {
    try {
      const response = await octokit.rest.pulls.get({
        owner: org,
        repo,
        pull_number: prNumber,
        mediaType: { format: "diff" },
      });
      return response.data as unknown as string;
    } catch (err) {
      if (!(err instanceof RequestError)) throw err;
      if (err.status === 404) throw new RepoNotFoundError(org, repo);

      lastError = err;
      if (attempt === MAX_DIFF_RETRIES) break;

      if (isRateLimitExhausted(err)) {
        // Wait until reset, then retry immediately — no additional backoff delay
        await waitForRateLimitReset(err);
        continue;
      }

      if (err.status >= 500) {
        const delay = Math.min(1_000 * Math.pow(2, attempt), 30_000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw err;
    }
  }

  throw lastError;
}

export async function fetchAndStoreDiff(
  org: string,
  repo: string,
  prNumber: number
): Promise<DiffResult> {
  let diffText: string;

  try {
    const octokit = getOctokit();
    diffText = await fetchDiffWithRetry(octokit, org, repo, prNumber);
  } catch (err) {
    if (err instanceof RepoNotFoundError) throw err;
    return { status: "fetch_failed", path: null };
  }

  const byteLength = Buffer.byteLength(diffText, "utf-8");
  if (byteLength > MAX_DIFF_BYTES) {
    return { status: "too_large", path: null };
  }

  const diffDir = join("data", "diffs", `${org}-${repo}`);
  const diffPath = join(diffDir, `${prNumber}.patch`);
  mkdirSync(diffDir, { recursive: true });
  writeFileSync(diffPath, diffText, "utf-8");

  return { status: "available", path: diffPath };
}
