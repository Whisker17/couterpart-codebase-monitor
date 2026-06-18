import { Octokit } from "octokit";
import { RequestError } from "@octokit/request-error";
import { getSettings } from "../../config/settings";

export interface PRData {
  number: number;
  title: string;
  body: string | null;
  author: string;
  merged_at: Date;
  changed_files: number;
  additions: number;
  deletions: number;
  node_id: string;
}

export interface PRStats {
  changed_files: number;
  additions: number;
  deletions: number;
}

export interface RepoMetadata {
  description: string | null;
  language: string | null;
  topics: string[];
}

export class RepoNotFoundError extends Error {
  constructor(
    public readonly org: string,
    public readonly repo: string
  ) {
    super(`Repository ${org}/${repo} not found (404) — may have been deleted or renamed`);
    this.name = "RepoNotFoundError";
  }
}

// Distinct from RepoNotFoundError: the repository itself is reachable (repos.get
// succeeds) but the pulls endpoint returns 404. GitHub does this when pull
// requests are disabled on a repo (e.g. a public push-mirror). The repo is not
// gone, it simply exposes no PRs — so there is nothing for a PR-based monitor to
// collect, and retrying is pointless.
export class PullsUnavailableError extends Error {
  constructor(
    public readonly org: string,
    public readonly repo: string
  ) {
    super(
      `Pull requests unavailable for ${org}/${repo} — the pulls endpoint returned 404 while the repository is reachable (pull requests are disabled on this repository)`
    );
    this.name = "PullsUnavailableError";
  }
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

const MAX_GITHUB_RETRIES = 3;
// A 404 is usually terminal (deleted / renamed / inaccessible repo), but GitHub
// intermittently returns 404 for a valid repo under load or replication lag.
// Retry a bounded number of times before declaring the repo gone, so a single
// transient 404 doesn't deactivate a tracked repo for the whole run.
const MAX_NOT_FOUND_RETRIES = 2;

interface GitHubRetryOptions {
  // Error to throw once a 404 is final. Defaults to RepoNotFoundError.
  onNotFound?: (org: string, repo: string) => Error;
  // Whether to retry a 404 before giving up. repos.get keeps this on (a repo
  // 404 can be a transient blip under load); pulls.list turns it off — a 404
  // there means pull requests are disabled, which is deterministic.
  retryNotFound?: boolean;
}

async function withGitHubRetry<T>(
  fn: () => Promise<T>,
  org: string,
  repo: string,
  opts: GitHubRetryOptions = {}
): Promise<T> {
  const makeNotFound = opts.onNotFound ?? ((o, r) => new RepoNotFoundError(o, r));
  const retryNotFound = opts.retryNotFound ?? true;
  let lastError: Error = new Error("unreachable");

  for (let attempt = 0; attempt <= MAX_GITHUB_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RequestError)) throw err;

      if (err.status === 404) {
        lastError = makeNotFound(org, repo);
        if (!retryNotFound || attempt >= MAX_NOT_FOUND_RETRIES) break;
        const delay = 1_000 * (attempt + 1);
        console.warn(
          `[GitHub] ${org}/${repo}: 404 (attempt ${attempt + 1}/${MAX_NOT_FOUND_RETRIES + 1}); retrying in ${delay}ms in case it is a transient 404...`
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      lastError = err;
      if (attempt === MAX_GITHUB_RETRIES) break;

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

      // Other 4xx: don't retry
      throw err;
    }
  }

  throw lastError;
}

export async function fetchMergedPRs(org: string, repo: string, since: Date): Promise<PRData[]> {
  const octokit = getOctokit();
  const results: PRData[] = [];

  let page = 1;
  outer: while (true) {
    const response = await withGitHubRetry(
      () =>
        octokit.rest.pulls.list({
          owner: org,
          repo,
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: 100,
          page,
        }),
      org,
      repo,
      { onNotFound: (o, r) => new PullsUnavailableError(o, r), retryNotFound: false }
    );

    const items = response.data;
    if (items.length === 0) break;

    for (const pr of items) {
      // Stop paging when we've passed items updated before our since window.
      // We use updated_at (not merged_at) because the list is sorted by updated;
      // an old PR updated recently could appear ahead of newer merged PRs.
      if (new Date(pr.updated_at) < since) break outer;

      if (!pr.merged_at) continue;
      const mergedAt = new Date(pr.merged_at);
      if (mergedAt <= since) continue;

      results.push({
        number: pr.number,
        title: pr.title,
        body: pr.body ?? null,
        author: pr.user?.login ?? "unknown",
        merged_at: mergedAt,
        // stats filled in by fetchPRStats after initial list — pulls.list omits them
        changed_files: 0,
        additions: 0,
        deletions: 0,
        node_id: pr.node_id,
      });
    }

    if (items.length < 100) break;
    page++;
  }

  return results;
}

export async function fetchPRStats(org: string, repo: string, prNumber: number): Promise<PRStats> {
  const octokit = getOctokit();
  const response = await withGitHubRetry(
    () => octokit.rest.pulls.get({ owner: org, repo, pull_number: prNumber }),
    org,
    repo
  );
  return {
    changed_files: response.data.changed_files,
    additions: response.data.additions,
    deletions: response.data.deletions,
  };
}

export async function fetchRepoMetadata(org: string, repo: string): Promise<RepoMetadata> {
  const octokit = getOctokit();
  const response = await withGitHubRetry(
    () => octokit.rest.repos.get({ owner: org, repo }),
    org,
    repo
  );
  const data = response.data;
  return {
    description: data.description ?? null,
    language: data.language ?? null,
    topics: data.topics ?? [],
  };
}
