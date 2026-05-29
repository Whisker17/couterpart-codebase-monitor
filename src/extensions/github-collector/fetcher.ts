import { Octokit } from "octokit";
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

export interface RepoMetadata {
  description: string | null;
  language: string | null;
  topics: string[];
}

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (_octokit) return _octokit;
  const { github } = getSettings();
  _octokit = new Octokit({ auth: github.token });
  return _octokit;
}

export async function fetchMergedPRs(org: string, repo: string, since: Date): Promise<PRData[]> {
  const octokit = getOctokit();
  const results: PRData[] = [];

  let page = 1;
  outer: while (true) {
    const response = await octokit.rest.pulls.list({
      owner: org,
      repo,
      state: "closed",
      sort: "updated",
      direction: "desc",
      per_page: 100,
      page,
    });

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
        // pulls.list doesn't return per-PR file stats; they'd require pulls.get
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

export async function fetchRepoMetadata(org: string, repo: string): Promise<RepoMetadata> {
  const octokit = getOctokit();
  const response = await octokit.rest.repos.get({ owner: org, repo });
  const data = response.data;
  return {
    description: data.description ?? null,
    language: data.language ?? null,
    topics: data.topics ?? [],
  };
}
