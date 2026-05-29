import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { getTrackedProjects } from "../../config/projects";
import { fetchMergedPRs, fetchRepoMetadata } from "../../extensions/github-collector/fetcher";
import { fetchAndStoreDiff } from "../../extensions/github-collector/diff-fetcher";
import type { PRData, RepoMetadata } from "../../extensions/github-collector/fetcher";
import type { DiffResult } from "../../extensions/github-collector/diff-fetcher";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface CollectDeps {
  fetchMergedPRs: (org: string, repo: string, since: Date) => Promise<PRData[]>;
  fetchRepoMetadata: (org: string, repo: string) => Promise<RepoMetadata>;
  fetchAndStoreDiff: (org: string, repo: string, prNumber: number) => Promise<DiffResult>;
}

const defaultDeps: CollectDeps = {
  fetchMergedPRs,
  fetchRepoMetadata,
  fetchAndStoreDiff,
};

function projectId(org: string, repo: string): string {
  return `${org}/${repo}`;
}

function ensureProjectsLoaded(): void {
  const db = getDb();
  const projects = getTrackedProjects();

  for (const p of projects) {
    const id = projectId(p.org, p.repo);
    db.run(
      `INSERT OR IGNORE INTO projects (id, org, repo, url) VALUES (?, ?, ?, ?)`,
      [id, p.org, p.repo, p.url]
    );
  }
}

export async function execute(
  _ctx: PipelineContext,
  deps: CollectDeps = defaultDeps
): Promise<StageResult> {
  const db = getDb();
  const projects = getTrackedProjects();
  const errors: string[] = [];
  const failedProjects: string[] = [];
  let totalPRs = 0;

  ensureProjectsLoaded();

  for (const project of projects) {
    const pid = projectId(project.org, project.repo);

    try {
      // Determine since: last_synced_at or 7 days ago
      const row = db
        .query<{ last_synced_at: number | null }, [string]>(
          "SELECT last_synced_at FROM projects WHERE id = ?"
        )
        .get(pid);

      const sinceMs = row?.last_synced_at
        ? row.last_synced_at * 1000
        : Date.now() - SEVEN_DAYS_MS;
      const since = new Date(sinceMs);

      // Fetch repo metadata and update projects table
      try {
        const meta = await deps.fetchRepoMetadata(project.org, project.repo);
        db.run(
          `UPDATE projects SET description = ?, language = ?, topics = ? WHERE id = ?`,
          [meta.description, meta.language, JSON.stringify(meta.topics), pid]
        );
      } catch (metaErr) {
        console.warn(
          `[Collect] Failed to fetch metadata for ${pid}: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`
        );
      }

      // Fetch merged PRs since last sync
      const prs = await deps.fetchMergedPRs(project.org, project.repo, since);
      console.log(`[Collect] ${pid}: fetched ${prs.length} merged PRs since ${since.toISOString()}`);

      let maxMergedAt: number | null = null;

      for (const pr of prs) {
        const mergedAtUnix = Math.floor(pr.merged_at.getTime() / 1000);

        // INSERT OR IGNORE for idempotency
        db.run(
          `INSERT OR IGNORE INTO pull_requests
            (project_id, pr_number, github_node_id, title, body, author, merged_at,
             files_changed, additions, deletions, diff_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')`,
          [
            pid,
            pr.number,
            pr.node_id,
            pr.title,
            pr.body,
            pr.author,
            mergedAtUnix,
            pr.changed_files,
            pr.additions,
            pr.deletions,
          ]
        );

        // Fetch and store diff; update diff_status regardless of PR insert result
        const diffResult = await deps.fetchAndStoreDiff(project.org, project.repo, pr.number);
        db.run(
          `UPDATE pull_requests SET diff_path = ?, diff_status = ?
           WHERE project_id = ? AND pr_number = ?`,
          [diffResult.path, diffResult.status, pid, pr.number]
        );

        if (maxMergedAt === null || mergedAtUnix > maxMergedAt) {
          maxMergedAt = mergedAtUnix;
        }
      }

      // Advance last_synced_at to max(merged_at) from this batch, not wall-clock now,
      // to avoid skipping PRs that were ingested late into GitHub's API.
      if (maxMergedAt !== null) {
        db.run(`UPDATE projects SET last_synced_at = ? WHERE id = ?`, [maxMergedAt, pid]);
      }

      totalPRs += prs.length;
    } catch (err) {
      const msg = `${pid}: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[Collect] Failed project ${msg}`);
      errors.push(msg);
      failedProjects.push(pid);
    }
  }

  return {
    success: errors.length === 0,
    itemsProcessed: totalPRs,
    errors,
    durationMs: 0,
    failedProjects,
  };
}

export const stage: PipelineStage = {
  name: "collect",
  execute,
};
