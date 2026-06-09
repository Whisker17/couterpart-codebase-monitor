import type { PipelineContext, PipelineStage, StageResult } from "../runner";
import { getDb } from "../../storage/db";
import { resolveProjectSnapshot } from "../../config/projects";
import { fetchMergedPRs, fetchRepoMetadata, fetchPRStats, RepoNotFoundError } from "../../extensions/github-collector/fetcher";
import { fetchAndStoreDiff } from "../../extensions/github-collector/diff-fetcher";
import type { PRData, RepoMetadata, PRStats } from "../../extensions/github-collector/fetcher";
import type { DiffResult } from "../../extensions/github-collector/diff-fetcher";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface CollectDeps {
  fetchMergedPRs: (org: string, repo: string, since: Date) => Promise<PRData[]>;
  fetchRepoMetadata: (org: string, repo: string) => Promise<RepoMetadata>;
  fetchPRStats: (org: string, repo: string, prNumber: number) => Promise<PRStats>;
  fetchAndStoreDiff: (org: string, repo: string, prNumber: number) => Promise<DiffResult>;
}

export interface CollectOptions {
  dateRangeOverride?: { startUnix: number; endUnix: number };
  skipSyncUpdate?: boolean;
}

const defaultDeps: CollectDeps = {
  fetchMergedPRs,
  fetchRepoMetadata,
  fetchPRStats,
  fetchAndStoreDiff,
};

function projectId(org: string, repo: string): string {
  return `${org}/${repo}`;
}

export async function execute(
  _ctx: PipelineContext,
  deps: CollectDeps = defaultDeps,
  options: CollectOptions = {}
): Promise<StageResult> {
  const db = getDb();
  let resolvedSnapshot;
  try {
    resolvedSnapshot = await resolveProjectSnapshot(db);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Collect] resolveProjectSnapshot failed: ${msg}`);
    return { success: false, itemsProcessed: 0, errors: [msg], durationMs: 0, failedProjects: [] };
  }
  const { projects, syncResult } = resolvedSnapshot;
  const errors: string[] = [];
  const failedProjects: string[] = [];
  let totalPRs = 0;

  for (const project of projects) {
    const pid = projectId(project.org, project.repo);

    try {
      // Determine since: dateRangeOverride, last_synced_at, or 7 days ago
      let since: Date;
      if (options.dateRangeOverride) {
        since = new Date((options.dateRangeOverride.startUnix - 1) * 1000);
      } else {
        const row = db
          .query<{ last_synced_at: number | null }, [string]>(
            "SELECT last_synced_at FROM projects WHERE id = ?"
          )
          .get(pid);
        const sinceMs = row?.last_synced_at
          ? row.last_synced_at * 1000
          : Date.now() - SEVEN_DAYS_MS;
        since = new Date(sinceMs);
      }

      // Fetch repo metadata and update projects table.
      // RepoNotFoundError is re-thrown so the outer catch marks the project inactive.
      try {
        const meta = await deps.fetchRepoMetadata(project.org, project.repo);
        db.run(
          `UPDATE projects SET description = ?, language = ?, topics = ? WHERE id = ?`,
          [meta.description, meta.language, JSON.stringify(meta.topics), pid]
        );
      } catch (metaErr) {
        if (metaErr instanceof RepoNotFoundError) throw metaErr;
        console.warn(
          `[Collect] Failed to fetch metadata for ${pid}: ${metaErr instanceof Error ? metaErr.message : String(metaErr)}`
        );
      }

      // Fetch merged PRs since last sync
      let prs = await deps.fetchMergedPRs(project.org, project.repo, since);
      console.log(`[Collect] ${pid}: fetched ${prs.length} merged PRs since ${since.toISOString()}`);

      if (options.dateRangeOverride) {
        const { startUnix, endUnix } = options.dateRangeOverride;
        prs = prs.filter((pr) => {
          const mergedAtUnix = Math.floor(pr.merged_at.getTime() / 1000);
          return mergedAtUnix >= startUnix && mergedAtUnix <= endUnix;
        });
      }

      let maxMergedAt: number | null = null;

      for (const pr of prs) {
        const mergedAtUnix = Math.floor(pr.merged_at.getTime() / 1000);

        // Fetch per-PR stats (changed_files/additions/deletions) via pulls.get
        let stats = { changed_files: 0, additions: 0, deletions: 0 };
        try {
          stats = await deps.fetchPRStats(project.org, project.repo, pr.number);
        } catch (statsErr) {
          console.warn(
            `[Collect] Failed to fetch stats for ${pid}#${pr.number}: ${statsErr instanceof Error ? statsErr.message : String(statsErr)}`
          );
        }

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
            stats.changed_files,
            stats.additions,
            stats.deletions,
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

      // Advance last_synced_at to max(merged_at) from this batch
      if (maxMergedAt !== null && !options.skipSyncUpdate) {
        db.run(`UPDATE projects SET last_synced_at = ? WHERE id = ?`, [maxMergedAt, pid]);
      }

      totalPRs += prs.length;
    } catch (err) {
      if (err instanceof RepoNotFoundError) {
        console.error(`[Collect] ALERT: ${err.message} — marking project inactive`);
        db.run(`UPDATE projects SET active = 0, inactive_reason = 'repo_not_found' WHERE id = ?`, [pid]);
        errors.push(`${pid}: repo not found (marked inactive)`);
        failedProjects.push(pid);
      } else {
        const msg = `${pid}: ${err instanceof Error ? err.message : String(err)}`;
        console.error(`[Collect] Failed project ${msg}`);
        errors.push(msg);
        failedProjects.push(pid);
      }
    }
  }

  return {
    success: errors.length === 0,
    itemsProcessed: totalPRs,
    errors,
    durationMs: 0,
    failedProjects,
    syncResult,
    resolvedProjectCount: projects.length,
  };
}

export const stage: PipelineStage = {
  name: "collect",
  execute,
};
