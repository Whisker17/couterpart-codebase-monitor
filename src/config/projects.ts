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
}

export interface CounterpartRelationship {
  source: string;
  targets: string[];
  relationship: "manual";
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

// Module-level cache is restricted to local-only (getTrackedProjects / reloadTrackedProjects).
// resolveProjectSnapshot never caches so remote data is not held across runs.
let _projects: TrackedProject[] | null = null;
let _mantleConfig: MantleConfig | null = null;
let _projectsConfigPath: string | null = null;

export function _resetProjectsCache(): void {
  _projects = null;
}

export function _setProjectsConfigPath(path: string | null): void {
  _projectsConfigPath = path;
}

function getProjectsConfigPath(): string {
  return _projectsConfigPath ?? join(process.cwd(), "config", "projects.json");
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
  const match = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Invalid GitHub URL: ${url}`);
  }
  return { org: match[1], repo: match[2] };
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

    let org: string;
    let repo: string;

    // Backward compat: explicit org/repo fields take precedence over URL parsing
    if (
      typeof entry.org === "string" &&
      entry.org.length > 0 &&
      typeof entry.repo === "string" &&
      entry.repo.length > 0
    ) {
      org = entry.org;
      repo = entry.repo;
    } else {
      const parsed = parseGitHubOrgRepo(url);
      org = parsed.org;
      repo = parsed.repo;
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

// ---- Legacy local-JSON validator (strict — used by getTrackedProjects / reloadTrackedProjects) ----

function validateLocalProjects(data: unknown): TrackedProject[] {
  if (!Array.isArray(data)) {
    throw new Error("projects.json must be an array");
  }
  for (const entry of data) {
    if (!entry || typeof entry.org !== "string" || entry.org.length === 0) {
      throw new Error("Each project must have a non-empty org");
    }
    if (typeof entry.repo !== "string" || entry.repo.length === 0) {
      throw new Error("Each project must have a non-empty repo");
    }
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://github.com/")) {
      throw new Error("Each project url must start with https://github.com/");
    }
  }
  return data as TrackedProject[];
}

// ---- HTTP subscription fetcher ----

export const projects = {
  fetchTimeoutMs: 10000,
};

export async function fetchSubscriptionText(timeoutMs = projects.fetchTimeoutMs): Promise<string> {
  const url = process.env.PROJECTS_SUBSCRIPTION_URL;
  if (!url) {
    throw new Error("PROJECTS_SUBSCRIPTION_URL is not set");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Subscription fetch failed: ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
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

    // Deactivate subscription rows absent from incoming set
    const subscriptionRows = db
      .query<{ id: string; active: number }, []>(
        "SELECT id, active FROM projects WHERE source = 'subscription'"
      )
      .all();

    for (const row of subscriptionRows) {
      if (!incomingIds.has(row.id) && row.active === 1) {
        db.query(
          "UPDATE projects SET active = 0, inactive_reason = 'subscription_removed' WHERE id = ? AND source = 'subscription'"
        ).run(row.id);
        deactivated.push(row.id);
      }
    }

    return { activated, deactivated, unchanged };
  });

  return txn();
}

// ---- Project resolver ----

export async function resolveProjectSnapshot(db: Database): Promise<ProjectSnapshot> {
  const subscriptionUrl = process.env.PROJECTS_SUBSCRIPTION_URL;

  if (subscriptionUrl) {
    let validatedProjects: TrackedProject[];

    try {
      const rawText = await fetchSubscriptionText();
      const data = JSON.parse(rawText);
      validatedProjects = parseAndValidateProjects(data);
    } catch (err) {
      console.error(`[subscription] Fetch or validation failed: ${err}`);

      const activeRows = db
        .query<
          { id: string; org: string; repo: string; url: string; tags: string | null; notes: string | null },
          []
        >("SELECT id, org, repo, url, tags, notes FROM projects WHERE source = 'subscription' AND active = 1")
        .all();

      if (activeRows.length === 0) {
        throw new Error(
          `[subscription] Fetch or validation failed and no prior subscription snapshot exists in SQLite. ` +
            `Fix the subscription URL or seed the database before retrying. Original error: ${err}`
        );
      }

      const fallback: TrackedProject[] = activeRows.map((r) => ({
        org: r.org,
        repo: r.repo,
        url: r.url,
        tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
        notes: r.notes ?? undefined,
      }));

      return { projects: fallback };
    }

    const syncResult = syncSubscriptionProjects(validatedProjects, db);

    const activeRows = db
      .query<
        { id: string; org: string; repo: string; url: string; tags: string | null; notes: string | null },
        []
      >("SELECT id, org, repo, url, tags, notes FROM projects WHERE source = 'subscription' AND active = 1")
      .all();

    const resolvedProjects: TrackedProject[] = activeRows.map((r) => ({
      org: r.org,
      repo: r.repo,
      url: r.url,
      tags: r.tags ? (JSON.parse(r.tags) as string[]) : [],
      notes: r.notes ?? undefined,
    }));

    return { projects: resolvedProjects, syncResult };
  }

  // Local JSON mode — not cached so subsequent runs pick up file changes
  const raw = readFileSync(getProjectsConfigPath(), "utf-8");
  const data = JSON.parse(raw);
  const localProjects = parseAndValidateProjects(data);

  for (const project of localProjects) {
    const projectId = `${project.org}/${project.repo}`;
    const existing = db
      .query<{ id: string }, [string]>("SELECT id FROM projects WHERE id = ?")
      .get(projectId);

    const tagsJson = JSON.stringify(project.tags ?? []);
    const notesVal = project.notes ?? null;

    if (existing) {
      db.query(
        `UPDATE projects SET active = 1, source = 'local', tags = ?, notes = ?, url = ?, org = ?, repo = ? WHERE id = ?`
      ).run(tagsJson, notesVal, project.url, project.org, project.repo, projectId);
    } else {
      db.query(
        `INSERT INTO projects (id, org, repo, url, source, active, tags, notes) VALUES (?, ?, ?, ?, 'local', 1, ?, ?)`
      ).run(projectId, project.org, project.repo, project.url, tagsJson, notesVal);
    }
  }

  return { projects: localProjects };
}

// ---- Legacy API (backward compat — local-only, uses module-level cache) ----

export function getTrackedProjects(): TrackedProject[] {
  if (_projects) return _projects;
  const raw = readFileSync(getProjectsConfigPath(), "utf-8");
  const data = JSON.parse(raw);
  _projects = validateLocalProjects(data);
  return _projects;
}

export function getMantleConfig(): MantleConfig {
  if (_mantleConfig) return _mantleConfig;
  const configPath = join(process.cwd(), "config", "mantle-config.json");
  const raw = readFileSync(configPath, "utf-8");
  _mantleConfig = JSON.parse(raw) as MantleConfig;
  return _mantleConfig;
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
    next = validateLocalProjects(data);
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
