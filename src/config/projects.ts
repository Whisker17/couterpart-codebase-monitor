import { readFileSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";

export interface ProjectConfig {
  org: string;
  repo: string;
  url: string;
  tags?: string[];
  notes?: string;
}

export type TrackedProject = ProjectConfig;

export interface MantleTarget {
  projectId: string;
  tags: string[];
  notes?: string;
  repoUrl?: string;
  branch?: string;
  architectureNotes?: string;
}

export interface CounterpartRelationship {
  source: string;
  targets: string[];
  relationship: "fork_of" | "depends_on" | "protocol_dependency" | "manual";
  reason: string;
}

export interface MantleConfig {
  mantleTargets: MantleTarget[];
  counterpartRelationships: CounterpartRelationship[];
}

export interface SyncResult {
  activated: string[];
  deactivated: string[];
  unchanged: string[];
}

export interface ProjectSnapshot {
  projects: TrackedProject[];
  syncResult?: SyncResult;
}

// Module-level cache for the legacy loaders (getTrackedProjects / reloadTrackedProjects).
// resolveProjectSnapshot never caches: it re-reads and re-syncs the projects file every
// run so the DB is reconciled even when the file is unchanged (e.g. a project marked
// inactive by a transient repo_not_found is reactivated on the next run).
let _projects: TrackedProject[] | null = null;
let _mantleConfig: MantleConfig | null = null;
let _projectsConfigPath: string | null = null;
let _mantleConfigPath: string | null = null;

export function _resetProjectsCache(): void {
  _projects = null;
}

export function _resetMantleConfigCache(): void {
  _mantleConfig = null;
}

export function _setProjectsConfigPath(path: string | null): void {
  _projectsConfigPath = path;
}

export function _setMantleConfigPath(path: string | null): void {
  _mantleConfigPath = path;
}

function getProjectsConfigPath(): string {
  return _projectsConfigPath ?? join(process.cwd(), "config", "projects.json");
}

function getMantleConfigPath(): string {
  return _mantleConfigPath ?? join(process.cwd(), "config", "mantle-config.json");
}

// ---- URL normalization ----

export function normalizeGitHubUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (url.startsWith("http://github.com/")) {
    url = "https://github.com/" + url.slice("http://github.com/".length);
  }
  while (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  if (url.endsWith(".git")) {
    url = url.slice(0, -4);
  }
  return url;
}

export function parseGitHubOrgRepo(url: string): { org: string; repo: string } {
  const normalized = normalizeGitHubUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }
  if (parsed.hostname !== "github.com") {
    throw new Error(`Invalid GitHub URL — expected github.com host: ${url}`);
  }
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new Error(
      `Invalid GitHub URL — expected exactly two path segments ({org}/{repo}): ${url}`
    );
  }
  const [org, repo] = segments;
  if (!org || !repo) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }
  return { org, repo };
}

// ---- Subscription JSON parser / validator ----

export function parseAndValidateProjects(data: unknown): TrackedProject[] {
  if (!Array.isArray(data)) {
    throw new Error("Subscription JSON must be an array");
  }

  const seen = new Set<string>();
  const result: TrackedProject[] = [];

  for (let i = 0; i < data.length; i++) {
    const entry = data[i] as Record<string, unknown>;

    if (!entry || typeof entry !== "object") {
      throw new Error(`Entry at index ${i} is not an object`);
    }

    if (typeof entry.url !== "string" || entry.url.length === 0) {
      throw new Error(`Entry at index ${i}: missing required field "url"`);
    }

    const url = normalizeGitHubUrl(entry.url);

    if (!url.startsWith("https://github.com/")) {
      throw new Error(`Entry at index ${i}: url must be a GitHub URL (got: ${entry.url})`);
    }

    // url is the canonical identity — always derive org/repo from it
    const { org, repo } = parseGitHubOrgRepo(url);

    // Backward compat: explicit org/repo allowed, but must match URL-derived values
    if (
      typeof entry.org === "string" &&
      entry.org.length > 0 &&
      typeof entry.repo === "string" &&
      entry.repo.length > 0
    ) {
      if (entry.org !== org || entry.repo !== repo) {
        throw new Error(
          `Entry at index ${i}: explicit org/repo "${entry.org}/${entry.repo}" does not match URL-derived identity "${org}/${repo}"`
        );
      }
    }

    const projectId = `${org}/${repo}`;
    if (seen.has(projectId)) {
      throw new Error(`Duplicate repository "${projectId}" in subscription source`);
    }
    seen.add(projectId);

    let tags: string[] = [];
    if (entry.tags !== undefined) {
      if (!Array.isArray(entry.tags)) {
        throw new Error(`Entry at index ${i}: "tags" must be an array`);
      }
      tags = entry.tags as string[];
    }

    const notes = typeof entry.notes === "string" ? entry.notes : undefined;

    // Unknown fields are intentionally ignored
    result.push({ org, repo, url, tags, notes });
  }

  return result;
}

// ---- SQLite subscription sync helper ----

interface ProjectRow {
  id: string;
  org: string;
  repo: string;
  url: string;
  source: string;
  active: number;
  tags: string | null;
  notes: string | null;
}

export function syncSubscriptionProjects(validatedProjects: TrackedProject[], db: Database): SyncResult {
  const txn = db.transaction((): SyncResult => {
    const activated: string[] = [];
    const deactivated: string[] = [];
    const unchanged: string[] = [];

    const incomingIds = new Set(validatedProjects.map((p) => `${p.org}/${p.repo}`));

    for (const project of validatedProjects) {
      const projectId = `${project.org}/${project.repo}`;
      const existing = db
        .query<ProjectRow, [string]>(
          "SELECT id, org, repo, url, source, active, tags, notes FROM projects WHERE id = ?"
        )
        .get(projectId);

      const tagsJson = JSON.stringify(project.tags ?? []);
      const notesVal = project.notes ?? null;

      if (existing) {
        db.query(
          `UPDATE projects SET
            active = 1,
            source = 'subscription',
            inactive_reason = NULL,
            subscription_synced_at = unixepoch(),
            tags = ?,
            notes = ?,
            url = ?,
            org = ?,
            repo = ?
          WHERE id = ?`
        ).run(tagsJson, notesVal, project.url, project.org, project.repo, projectId);

        if (existing.active === 0) {
          activated.push(projectId);
        } else {
          unchanged.push(projectId);
        }
      } else {
        db.query(
          `INSERT INTO projects (id, org, repo, url, source, active, inactive_reason, subscription_synced_at, tags, notes)
           VALUES (?, ?, ?, ?, 'subscription', 1, NULL, unixepoch(), ?, ?)`
        ).run(projectId, project.org, project.repo, project.url, tagsJson, notesVal);
        activated.push(projectId);
      }
    }

    // Deactivate rows absent from the incoming set. Covers source='local' too:
    // rows created by the removed local mode (or defaulted by migration) would
    // otherwise stay active forever once dropped from the projects file.
    const trackedRows = db
      .query<{ id: string; active: number }, []>(
        "SELECT id, active FROM projects WHERE source IN ('subscription', 'local')"
      )
      .all();

    for (const row of trackedRows) {
      if (!incomingIds.has(row.id) && row.active === 1) {
        db.query(
          "UPDATE projects SET active = 0, inactive_reason = 'subscription_removed' WHERE id = ? AND source IN ('subscription', 'local')"
        ).run(row.id);
        deactivated.push(row.id);
      }
    }

    return { activated, deactivated, unchanged };
  });

  return txn();
}

// ---- Project resolver ----

// Includes source='local' so an upgraded DB that only has pre-migration local rows
// still yields a usable fallback snapshot before the first successful file sync.
// After a sync this is equivalent to subscription-only: file-listed rows are converted
// to source='subscription' and stale local rows are deactivated.
function readActiveTrackedProjects(db: Database): TrackedProject[] {
  const activeRows = db
    .query<
      { id: string; org: string; repo: string; url: string; tags: string | null; notes: string | null },
      []
    >(
      "SELECT id, org, repo, url, tags, notes FROM projects WHERE source IN ('subscription', 'local') AND active = 1"
    )
    .all();

  return activeRows.map((r) => ({
    org: r.org,
    repo: r.repo,
    url: r.url,
    tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
    notes: r.notes ?? undefined,
  }));
}

// Reads the subscription file (config/projects.json) on every call so edits are picked
// up without a restart, and always runs the DB sync so SQLite is reconciled back to the
// file-defined set even when the file content is unchanged.
export async function resolveProjectSnapshot(db: Database): Promise<ProjectSnapshot> {
  let validatedProjects: TrackedProject[];

  try {
    const rawText = readFileSync(getProjectsConfigPath(), "utf-8");
    validatedProjects = parseAndValidateProjects(JSON.parse(rawText));
  } catch (err) {
    console.error(`[subscription] Projects file read or validation failed: ${err}`);

    const fallback = readActiveTrackedProjects(db);
    if (fallback.length === 0) {
      throw new Error(
        `[subscription] Projects file read or validation failed and no prior tracked-project snapshot exists in SQLite. ` +
          `Fix ${getProjectsConfigPath()} or seed the database before retrying. Original error: ${err}`
      );
    }

    return { projects: fallback };
  }

  const syncResult = syncSubscriptionProjects(validatedProjects, db);

  return { projects: readActiveTrackedProjects(db), syncResult };
}

// ---- Legacy API (backward compat — local-only, uses module-level cache) ----

export function getTrackedProjects(): TrackedProject[] {
  if (_projects) return _projects;
  const raw = readFileSync(getProjectsConfigPath(), "utf-8");
  const data = JSON.parse(raw);
  _projects = parseAndValidateProjects(data);
  return _projects;
}

const RELATIONSHIP_STRENGTH: Record<CounterpartRelationship["relationship"], number> = {
  fork_of: 4,
  depends_on: 3,
  protocol_dependency: 2,
  manual: 1,
};

function deduplicateRelationships(rels: CounterpartRelationship[]): CounterpartRelationship[] {
  // Track best (source, target) → {relationship entry, strength}
  const best = new Map<string, { rel: CounterpartRelationship; target: string; strength: number }>();

  for (const rel of rels) {
    for (const target of rel.targets) {
      const key = `${rel.source}\x00${target}`;
      const strength = RELATIONSHIP_STRENGTH[rel.relationship] ?? 0;
      const current = best.get(key);
      if (!current || strength > current.strength) {
        best.set(key, { rel, target, strength });
      }
    }
  }

  // Re-group by (source, relationship) to reconstruct the de-duplicated list
  const grouped = new Map<string, CounterpartRelationship>();
  for (const { rel, target } of best.values()) {
    const groupKey = `${rel.source}\x00${rel.relationship}`;
    const existing = grouped.get(groupKey);
    if (existing) {
      existing.targets.push(target);
    } else {
      grouped.set(groupKey, {
        source: rel.source,
        targets: [target],
        relationship: rel.relationship,
        reason: rel.reason,
      });
    }
  }

  return Array.from(grouped.values());
}

export function getMantleConfig(): MantleConfig {
  if (_mantleConfig) return _mantleConfig;
  const raw = readFileSync(getMantleConfigPath(), "utf-8");
  const parsed = JSON.parse(raw) as MantleConfig;
  _mantleConfig = {
    ...parsed,
    counterpartRelationships: deduplicateRelationships(parsed.counterpartRelationships ?? []),
  };
  return _mantleConfig;
}

export function reloadMantleConfig(): {
  config: MantleConfig;
  prevConfig: MantleConfig | null;
  changed: boolean;
} {
  const prev = _mantleConfig;

  let next: MantleConfig;
  try {
    const raw = readFileSync(getMantleConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as MantleConfig;
    next = {
      ...parsed,
      counterpartRelationships: deduplicateRelationships(parsed.counterpartRelationships ?? []),
    };
  } catch (e) {
    if (prev) {
      console.warn(`[config-reload] Failed to reload mantle-config.json, using cached config: ${e}`);
      return { config: prev, prevConfig: prev, changed: false };
    }
    throw new Error(`[config-reload] mantle-config.json invalid and no cached mantle config available: ${e}`);
  }

  const changed = JSON.stringify(prev) !== JSON.stringify(next);
  _mantleConfig = next;
  return { config: next, prevConfig: prev, changed };
}

export function validateMantleConfig(
  config: MantleConfig,
  trackedProjectIds: Set<string>,
  impactCheckEnabled: boolean
): void {
  const targetMap = new Map<string, MantleTarget>();
  for (const t of config.mantleTargets) {
    targetMap.set(t.projectId, t);
  }

  const referencedTargetIds = new Set<string>();
  for (const rel of config.counterpartRelationships) {
    for (const t of rel.targets) {
      referencedTargetIds.add(t);
    }
  }

  if (impactCheckEnabled) {
    for (const targetId of referencedTargetIds) {
      const target = targetMap.get(targetId);
      if (!target) continue;
      if (!target.repoUrl || !target.repoUrl.startsWith("https://github.com/")) {
        throw new Error(
          `[config] impactCheck.enabled=true but target "${targetId}" has missing or invalid repoUrl (must be https://github.com/ prefixed)`
        );
      }
    }
  }

  for (const rel of config.counterpartRelationships) {
    if (!trackedProjectIds.has(rel.source)) {
      console.warn(
        `[config] counterpartRelationship source "${rel.source}" is not in tracked projects — relationship will never trigger`
      );
    }
  }

  for (const rel of config.counterpartRelationships) {
    if (rel.relationship === "protocol_dependency") {
      for (const targetId of rel.targets) {
        const target = targetMap.get(targetId);
        if (target && (!target.architectureNotes || target.architectureNotes.trim() === "")) {
          console.warn(
            `[config] protocol_dependency from "${rel.source}" to "${targetId}" has no architectureNotes — reasoning has no knowledge base`
          );
        }
      }
    }
  }
}

export function reloadTrackedProjects(): {
  projects: TrackedProject[];
  prevProjects: TrackedProject[] | null;
  changed: boolean;
} {
  const prev = _projects;

  let next: TrackedProject[];
  try {
    const raw = readFileSync(getProjectsConfigPath(), "utf-8");
    const data = JSON.parse(raw);
    next = parseAndValidateProjects(data);
  } catch (e) {
    if (prev) {
      console.warn(`[config-reload] Failed to reload projects.json, using cached projects: ${e}`);
      return { projects: prev, prevProjects: prev, changed: false };
    }
    throw new Error(`[config-reload] projects.json invalid and no cached projects available: ${e}`);
  }

  const changed = JSON.stringify(prev) !== JSON.stringify(next);
  _projects = next;
  return { projects: next, prevProjects: prev, changed };
}
