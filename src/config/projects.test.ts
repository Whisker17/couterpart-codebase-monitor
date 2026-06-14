import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import {
  getTrackedProjects,
  reloadTrackedProjects,
  resolveProjectSnapshot,
  _resetProjectsCache,
  _setProjectsConfigPath,
  normalizeGitHubUrl,
  parseGitHubOrgRepo,
  parseAndValidateProjects,
  getMantleConfig,
  reloadMantleConfig,
  validateMantleConfig,
  _resetMantleConfigCache,
  _setMantleConfigPath,
  type MantleConfig,
  type CounterpartRelationship,
} from "./projects.ts";

describe("getTrackedProjects", () => {
  beforeEach(() => {
    // Reset module cache between tests
    // @ts-ignore - reset private cache
    // We'll re-import fresh each time via a wrapper
  });

  it("returns an array of projects", async () => {
    const { getTrackedProjects } = await import("./projects.ts");
    const ps = getTrackedProjects();
    expect(Array.isArray(ps)).toBe(true);
    expect(ps.length).toBeGreaterThanOrEqual(3);
    expect(ps.length).toBeLessThanOrEqual(10);
  });

  it("each project has required fields", async () => {
    const { getTrackedProjects } = await import("./projects.ts");
    const ps = getTrackedProjects();
    for (const p of ps) {
      expect(typeof p.org).toBe("string");
      expect(p.org.length).toBeGreaterThan(0);
      expect(typeof p.repo).toBe("string");
      expect(p.repo.length).toBeGreaterThan(0);
      expect(typeof p.url).toBe("string");
      expect(p.url).toStartWith("https://github.com/");
    }
  });

  it("includes expected projects", async () => {
    const { getTrackedProjects } = await import("./projects.ts");
    const ps = getTrackedProjects();
    const keys = ps.map((p) => `${p.org}/${p.repo}`);
    expect(keys).toContain("ethereum/go-ethereum");
    expect(keys).toContain("ethereum-optimism/optimism");
  });

  it("returns the same reference on repeated calls (cached)", async () => {
    const { getTrackedProjects } = await import("./projects.ts");
    const a = getTrackedProjects();
    const b = getTrackedProjects();
    expect(a).toBe(b);
  });
});

describe("reloadTrackedProjects", () => {
  const baseProjects = [
    { org: "base", repo: "base", url: "https://github.com/base/base" },
    { org: "foo", repo: "bar", url: "https://github.com/foo/bar" },
  ];

  let tmpPath: string;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `projects-reload-test-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(baseProjects));
    _setProjectsConfigPath(tmpPath);
    _resetProjectsCache();
  });

  afterEach(() => {
    _resetProjectsCache();
    _setProjectsConfigPath(null);
    try {
      unlinkSync(tmpPath);
    } catch {}
  });

  // Test 7: Project added — next collect sees it
  it("warm reload picks up a newly added project", () => {
    reloadTrackedProjects();
    expect(getTrackedProjects().length).toBe(2);

    const updated = [...baseProjects, { org: "new", repo: "proj", url: "https://github.com/new/proj" }];
    writeFileSync(tmpPath, JSON.stringify(updated));

    const { projects: ps, changed } = reloadTrackedProjects();
    expect(changed).toBe(true);
    expect(ps.length).toBe(3);
    expect(ps.map((p) => `${p.org}/${p.repo}`)).toContain("new/proj");
    expect(getTrackedProjects().length).toBe(3);
  });

  // Test 8: Project removed — next collect skips it, DB rows unaffected
  it("warm reload excludes removed project without touching persistent state", () => {
    reloadTrackedProjects();
    expect(getTrackedProjects().map((p) => `${p.org}/${p.repo}`)).toContain("foo/bar");

    // Remove foo/bar
    writeFileSync(tmpPath, JSON.stringify([baseProjects[0]]));

    const { projects: ps, changed } = reloadTrackedProjects();
    expect(changed).toBe(true);
    expect(ps.map((p) => `${p.org}/${p.repo}`)).not.toContain("foo/bar");
    expect(ps.length).toBe(1);
    // reloadTrackedProjects makes no DB calls — DB history is untouched by design
  });

  // Test 9: Projects JSON parse failure (cache exists) — old list kept, warning
  it("warm reload with invalid JSON keeps old list and logs a warning", () => {
    reloadTrackedProjects();
    const originalLength = getTrackedProjects().length;

    writeFileSync(tmpPath, "{ invalid json }");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { projects: ps, changed } = reloadTrackedProjects();
    expect(changed).toBe(false);
    expect(ps.length).toBe(originalLength);
    expect(getTrackedProjects().length).toBe(originalLength);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[config-reload]"));
    warnSpy.mockRestore();
  });

  // Test 10: Projects cold start failure — throws, no stage executed
  it("cold start with invalid JSON throws without initialising projects", () => {
    writeFileSync(tmpPath, "not json at all");
    expect(() => reloadTrackedProjects()).toThrow("[config-reload]");
  });

  it("cold start validates that top-level must be an array", () => {
    writeFileSync(tmpPath, JSON.stringify({ org: "foo", repo: "bar" }));
    expect(() => reloadTrackedProjects()).toThrow();
  });

  it("cold start validates url starts with https://github.com/", () => {
    writeFileSync(
      tmpPath,
      JSON.stringify([{ org: "foo", repo: "bar", url: "https://gitlab.com/foo/bar" }])
    );
    expect(() => reloadTrackedProjects()).toThrow();
  });
});

// ---- URL normalization ----

describe("normalizeGitHubUrl", () => {
  it("leaves a clean https URL unchanged", () => {
    expect(normalizeGitHubUrl("https://github.com/base/base")).toBe("https://github.com/base/base");
  });

  it("normalizes http:// to https://", () => {
    expect(normalizeGitHubUrl("http://github.com/base/base")).toBe("https://github.com/base/base");
  });

  it("strips trailing .git suffix", () => {
    expect(normalizeGitHubUrl("https://github.com/base/base.git")).toBe("https://github.com/base/base");
  });

  it("strips trailing slash", () => {
    expect(normalizeGitHubUrl("https://github.com/base/base/")).toBe("https://github.com/base/base");
  });

  it("strips both trailing slash and .git", () => {
    expect(normalizeGitHubUrl("https://github.com/base/base.git/")).toBe("https://github.com/base/base");
  });

  it("normalizes http:// with trailing .git", () => {
    expect(normalizeGitHubUrl("http://github.com/org/repo.git")).toBe("https://github.com/org/repo");
  });
});

describe("parseGitHubOrgRepo", () => {
  it("extracts org and repo from a canonical URL", () => {
    expect(parseGitHubOrgRepo("https://github.com/ethereum-optimism/optimism")).toEqual({
      org: "ethereum-optimism",
      repo: "optimism",
    });
  });

  it("normalizes before parsing — http, .git, trailing slash", () => {
    expect(parseGitHubOrgRepo("http://github.com/base/base.git/")).toEqual({
      org: "base",
      repo: "base",
    });
  });

  it("throws for non-GitHub URL", () => {
    expect(() => parseGitHubOrgRepo("https://gitlab.com/foo/bar")).toThrow();
  });

  it("throws for URL with too few path segments", () => {
    expect(() => parseGitHubOrgRepo("https://github.com/onlyone")).toThrow();
  });
});

// ---- parseAndValidateProjects ----

// Helper: assert non-empty result and return first element with TypeScript narrowing
function first(arr: ReturnType<typeof parseAndValidateProjects>) {
  expect(arr).toHaveLength(1);
  const item = arr[0];
  if (!item) throw new Error("Expected non-empty result array");
  return item;
}

describe("parseAndValidateProjects — URL-only subscription entries", () => {
  it("derives org and repo from url", () => {
    const item = first(parseAndValidateProjects([{ url: "https://github.com/base/base" }]));
    expect(item.org).toBe("base");
    expect(item.repo).toBe("base");
  });

  it("normalizes http:// subscription url to https://", () => {
    const item = first(parseAndValidateProjects([{ url: "http://github.com/base/base" }]));
    expect(item.url).toBe("https://github.com/base/base");
    expect(item.org).toBe("base");
  });

  it("strips trailing slash from subscription url", () => {
    const item = first(parseAndValidateProjects([{ url: "https://github.com/base/base/" }]));
    expect(item.url).toBe("https://github.com/base/base");
  });

  it("strips .git suffix from subscription url", () => {
    const item = first(parseAndValidateProjects([{ url: "https://github.com/base/base.git" }]));
    expect(item.url).toBe("https://github.com/base/base");
    expect(item.repo).toBe("base");
  });

  it("defaults tags to [] when not specified", () => {
    const item = first(parseAndValidateProjects([{ url: "https://github.com/base/base" }]));
    expect(item.tags).toEqual([]);
  });

  it("preserves provided tags", () => {
    const item = first(
      parseAndValidateProjects([{ url: "https://github.com/base/base", tags: ["blockchain", "l2"] }])
    );
    expect(item.tags).toEqual(["blockchain", "l2"]);
  });

  it("preserves notes when provided", () => {
    const item = first(
      parseAndValidateProjects([{ url: "https://github.com/base/base", notes: "analyst context" }])
    );
    expect(item.notes).toBe("analyst context");
  });

  it("notes is undefined when not provided", () => {
    const item = first(parseAndValidateProjects([{ url: "https://github.com/base/base" }]));
    expect(item.notes).toBeUndefined();
  });

  it("ignores unknown fields", () => {
    const item = first(
      parseAndValidateProjects([
        { url: "https://github.com/base/base", unknownField: "ignored", anotherField: 42 },
      ])
    );
    expect(item.org).toBe("base");
    expect("unknownField" in item).toBe(false);
  });
});

describe("parseAndValidateProjects — local JSON backward compat", () => {
  it("accepts entries with explicit org and repo that match the URL", () => {
    const item = first(
      parseAndValidateProjects([{ org: "base", repo: "base", url: "https://github.com/base/base" }])
    );
    expect(item.org).toBe("base");
    expect(item.repo).toBe("base");
  });

  it("accepts explicit org/repo when they match the URL-derived identity", () => {
    const item = first(
      parseAndValidateProjects([
        { org: "myorg", repo: "myrepo", url: "https://github.com/myorg/myrepo", tags: ["tag1"] },
      ])
    );
    expect(item.org).toBe("myorg");
    expect(item.repo).toBe("myrepo");
  });
});

describe("parseAndValidateProjects — validation errors", () => {
  it("throws when top-level is not an array", () => {
    expect(() => parseAndValidateProjects({ url: "https://github.com/a/b" })).toThrow("array");
  });

  it("throws when url is missing", () => {
    expect(() => parseAndValidateProjects([{ org: "foo", repo: "bar" }])).toThrow("url");
  });

  it("throws when url is not a GitHub URL", () => {
    expect(() =>
      parseAndValidateProjects([{ url: "https://gitlab.com/foo/bar" }])
    ).toThrow("GitHub");
  });

  it("throws on duplicate org/repo within one batch", () => {
    expect(() =>
      parseAndValidateProjects([
        { url: "https://github.com/base/base" },
        { url: "https://github.com/base/base" },
      ])
    ).toThrow("Duplicate");
  });

  it("reports duplicate when http and https variants refer to same repo", () => {
    expect(() =>
      parseAndValidateProjects([
        { url: "https://github.com/base/base" },
        { url: "http://github.com/base/base" },
      ])
    ).toThrow("Duplicate");
  });

  it("throws when url is an empty string", () => {
    expect(() => parseAndValidateProjects([{ url: "" }])).toThrow("url");
  });

  it("throws when url has extra path segments beyond org/repo", () => {
    expect(() =>
      parseAndValidateProjects([{ url: "https://github.com/base/base/issues" }])
    ).toThrow();
  });

  it("throws when url has only one path segment", () => {
    expect(() =>
      parseAndValidateProjects([{ url: "https://github.com/onlyone" }])
    ).toThrow();
  });

  it("throws when explicit org does not match URL-derived org", () => {
    expect(() =>
      parseAndValidateProjects([
        { url: "https://github.com/base/base", org: "wrong", repo: "base" },
      ])
    ).toThrow();
  });

  it("throws when explicit repo does not match URL-derived repo", () => {
    expect(() =>
      parseAndValidateProjects([
        { url: "https://github.com/base/base", org: "base", repo: "wrong" },
      ])
    ).toThrow();
  });

  it("throws when two entries share the same URL but second has different explicit org", () => {
    expect(() =>
      parseAndValidateProjects([
        { url: "https://github.com/base/base" },
        { url: "https://github.com/base/base", org: "different", repo: "different" },
      ])
    ).toThrow();
  });
});

// ---- resolveProjectSnapshot — local subscription file ----

describe("resolveProjectSnapshot", () => {
  let db: Database;
  let tmpPath: string;

  const fileV1 = [
    { url: "https://github.com/base/base", tags: ["l2"] },
    { url: "https://github.com/foo/bar", notes: "counterpart" },
  ];

  beforeEach(() => {
    db = new Database(":memory:");
    db.run(`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT DEFAULT 'local',
      active INTEGER DEFAULT 1,
      inactive_reason TEXT,
      subscription_synced_at INTEGER,
      tags TEXT,
      notes TEXT
    )`);
    tmpPath = join(tmpdir(), `projects-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tmpPath, JSON.stringify(fileV1));
    _setProjectsConfigPath(tmpPath);
    _resetProjectsCache();
  });

  afterEach(() => {
    db.close();
    _resetProjectsCache();
    _setProjectsConfigPath(null);
    try {
      unlinkSync(tmpPath);
    } catch {}
  });

  it("first run syncs file content into SQLite and returns a syncResult", async () => {
    const snapshot = await resolveProjectSnapshot(db);

    expect(snapshot.syncResult).toBeDefined();
    expect(snapshot.syncResult!.activated.sort()).toEqual(["base/base", "foo/bar"]);
    expect(snapshot.projects.map((p) => `${p.org}/${p.repo}`).sort()).toEqual(["base/base", "foo/bar"]);

    const row = db
      .query<{ source: string; active: number }, []>("SELECT source, active FROM projects WHERE id = 'base/base'")
      .get();
    expect(row!.source).toBe("subscription");
    expect(row!.active).toBe(1);
  });

  it("unchanged file still reconciles SQLite: reactivates an externally deactivated project", async () => {
    await resolveProjectSnapshot(db);

    // Simulate collect marking a project inactive after a transient repo_not_found
    db.run("UPDATE projects SET active = 0, inactive_reason = 'repo_not_found' WHERE id = 'base/base'");

    const second = await resolveProjectSnapshot(db);

    expect(second.syncResult).toBeDefined();
    expect(second.syncResult!.activated).toEqual(["base/base"]);
    expect(second.projects.map((p) => `${p.org}/${p.repo}`).sort()).toEqual(["base/base", "foo/bar"]);

    const row = db
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'base/base'"
      )
      .get();
    expect(row!.active).toBe(1);
    expect(row!.inactive_reason).toBeNull();
  });

  it("syncs a fresh DB handle even when the file was already synced into another DB", async () => {
    await resolveProjectSnapshot(db);

    const secondDb = new Database(":memory:");
    secondDb.run(`CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      url TEXT NOT NULL,
      source TEXT DEFAULT 'local',
      active INTEGER DEFAULT 1,
      inactive_reason TEXT,
      subscription_synced_at INTEGER,
      tags TEXT,
      notes TEXT
    )`);

    const snapshot = await resolveProjectSnapshot(secondDb);
    secondDb.close();

    expect(snapshot.syncResult).toBeDefined();
    expect(snapshot.projects.map((p) => `${p.org}/${p.repo}`).sort()).toEqual(["base/base", "foo/bar"]);
  });

  it("deactivates stale source='local' rows absent from the file", async () => {
    db.run(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES ('old/legacy', 'old', 'legacy', 'https://github.com/old/legacy', 'local', 1)`
    );

    const snapshot = await resolveProjectSnapshot(db);

    expect(snapshot.syncResult!.deactivated).toEqual(["old/legacy"]);
    expect(snapshot.projects.map((p) => `${p.org}/${p.repo}`).sort()).toEqual(["base/base", "foo/bar"]);

    const row = db
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'old/legacy'"
      )
      .get();
    expect(row!.active).toBe(0);
    expect(row!.inactive_reason).toBe("subscription_removed");
  });

  it("edited file re-syncs: adds new projects and deactivates removed ones", async () => {
    await resolveProjectSnapshot(db);

    const fileV2 = [
      { url: "https://github.com/base/base", tags: ["l2"] },
      { url: "https://github.com/new/proj" },
    ];
    writeFileSync(tmpPath, JSON.stringify(fileV2));

    const snapshot = await resolveProjectSnapshot(db);

    expect(snapshot.syncResult).toBeDefined();
    expect(snapshot.syncResult!.activated).toEqual(["new/proj"]);
    expect(snapshot.syncResult!.deactivated).toEqual(["foo/bar"]);
    expect(snapshot.projects.map((p) => `${p.org}/${p.repo}`).sort()).toEqual(["base/base", "new/proj"]);

    const removed = db
      .query<{ active: number; inactive_reason: string | null }, []>(
        "SELECT active, inactive_reason FROM projects WHERE id = 'foo/bar'"
      )
      .get();
    expect(removed!.active).toBe(0);
    expect(removed!.inactive_reason).toBe("subscription_removed");
  });

  it("invalid file falls back to the last successful SQLite snapshot", async () => {
    await resolveProjectSnapshot(db);

    writeFileSync(tmpPath, "{ not valid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const snapshot = await resolveProjectSnapshot(db);

    expect(snapshot.syncResult).toBeUndefined();
    expect(snapshot.projects.map((p) => `${p.org}/${p.repo}`).sort()).toEqual(["base/base", "foo/bar"]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[subscription]"));
    errorSpy.mockRestore();
  });

  it("invalid file falls back to pre-migration source='local' rows on an upgraded DB", async () => {
    // Upgraded DB: only active rows are pre-migration source='local', no successful
    // file sync has happened yet
    db.run(
      `INSERT INTO projects (id, org, repo, url, source, active) VALUES ('old/legacy', 'old', 'legacy', 'https://github.com/old/legacy', 'local', 1)`
    );
    writeFileSync(tmpPath, "{ not valid json");
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    const snapshot = await resolveProjectSnapshot(db);

    expect(snapshot.syncResult).toBeUndefined();
    expect(snapshot.projects.map((p) => `${p.org}/${p.repo}`)).toEqual(["old/legacy"]);
    errorSpy.mockRestore();
  });

  it("missing file with no prior snapshot throws", async () => {
    unlinkSync(tmpPath);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    await expect(resolveProjectSnapshot(db)).rejects.toThrow("no prior tracked-project snapshot");
    errorSpy.mockRestore();
  });
});

// ---- CounterpartRelationship type ----

describe("CounterpartRelationship — relationship type", () => {
  it("accepts fork_of as a valid relationship value", () => {
    const rel: CounterpartRelationship = {
      source: "org/repo",
      targets: ["mantle/reth"],
      relationship: "fork_of",
      reason: "fork",
    };
    expect(rel.relationship).toBe("fork_of");
  });

  it("accepts depends_on as a valid relationship value", () => {
    const rel: CounterpartRelationship = {
      source: "org/repo",
      targets: ["mantle/reth"],
      relationship: "depends_on",
      reason: "dep",
    };
    expect(rel.relationship).toBe("depends_on");
  });

  it("accepts protocol_dependency as a valid relationship value", () => {
    const rel: CounterpartRelationship = {
      source: "org/repo",
      targets: ["mantle/reth"],
      relationship: "protocol_dependency",
      reason: "proto",
    };
    expect(rel.relationship).toBe("protocol_dependency");
  });

  it("accepts manual as a valid relationship value (backward compat)", () => {
    const rel: CounterpartRelationship = {
      source: "org/repo",
      targets: ["mantle/reth"],
      relationship: "manual",
      reason: "manual",
    };
    expect(rel.relationship).toBe("manual");
  });
});

// ---- reloadMantleConfig ----

describe("reloadMantleConfig", () => {
  const baseMantleConfig: MantleConfig = {
    mantleTargets: [
      {
        projectId: "mantle/reth",
        repoUrl: "https://github.com/mantleio/reth",
        branch: "main",
        tags: ["reth"],
        notes: "test target",
        architectureNotes: "Some architecture notes",
      },
    ],
    counterpartRelationships: [
      {
        source: "org/repo",
        targets: ["mantle/reth"],
        relationship: "fork_of",
        reason: "downstream fork",
      },
    ],
  };

  let tmpPath: string;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `mantle-config-reload-test-${Date.now()}.json`);
    writeFileSync(tmpPath, JSON.stringify(baseMantleConfig));
    _setMantleConfigPath(tmpPath);
    _resetMantleConfigCache();
  });

  afterEach(() => {
    _resetMantleConfigCache();
    _setMantleConfigPath(null);
    try { unlinkSync(tmpPath); } catch {}
  });

  it("returns fresh data when file changes", () => {
    reloadMantleConfig();
    expect(getMantleConfig().mantleTargets[0]!.notes).toBe("test target");

    const updated: MantleConfig = {
      ...baseMantleConfig,
      mantleTargets: [{ ...baseMantleConfig.mantleTargets[0]!, notes: "updated notes" }],
    };
    writeFileSync(tmpPath, JSON.stringify(updated));

    const { config, changed } = reloadMantleConfig();
    expect(changed).toBe(true);
    expect(config.mantleTargets[0]!.notes).toBe("updated notes");
    expect(getMantleConfig().mantleTargets[0]!.notes).toBe("updated notes");
  });

  it("warm reload with invalid JSON keeps cached config and logs a warning", () => {
    reloadMantleConfig();
    writeFileSync(tmpPath, "{ invalid json }");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { changed } = reloadMantleConfig();
    expect(changed).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[config-reload]"));
    warnSpy.mockRestore();
  });

  it("cold start with invalid JSON throws", () => {
    writeFileSync(tmpPath, "not json at all");
    expect(() => reloadMantleConfig()).toThrow("[config-reload]");
  });

  it("rejects duplicate source→target relationships instead of silently choosing one", () => {
    const withDuplicates: MantleConfig = {
      mantleTargets: baseMantleConfig.mantleTargets,
      counterpartRelationships: [
        { source: "org/a", targets: ["mantle/reth"], relationship: "manual", reason: "low" },
        { source: "org/a", targets: ["mantle/reth"], relationship: "fork_of", reason: "high" },
        { source: "org/a", targets: ["mantle/reth"], relationship: "depends_on", reason: "mid" },
      ],
    };
    writeFileSync(tmpPath, JSON.stringify(withDuplicates));

    expect(() => reloadMantleConfig()).toThrow(/duplicate counterpartRelationship/i);
  });

  it("warm reload fails on duplicate source→target relationships instead of keeping cached config", () => {
    reloadMantleConfig();
    const withDuplicates: MantleConfig = {
      mantleTargets: baseMantleConfig.mantleTargets,
      counterpartRelationships: [
        { source: "org/a", targets: ["mantle/reth"], relationship: "manual", reason: "low" },
        { source: "org/a", targets: ["mantle/reth"], relationship: "fork_of", reason: "high" },
      ],
    };
    writeFileSync(tmpPath, JSON.stringify(withDuplicates));

    expect(() => reloadMantleConfig()).toThrow(/duplicate counterpartRelationship/i);
  });
});

// ---- validateMantleConfig ----

describe("validateMantleConfig", () => {
  const validTarget = {
    projectId: "mantle/reth",
    repoUrl: "https://github.com/mantleio/reth",
    branch: "main",
    tags: [],
    architectureNotes: "Detailed notes about architecture",
  };

  const trackedProjects = new Set(["org/source-repo", "other/tracked"]);

  it("throws hard error when enabled=true and referenced target has no repoUrl", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: [] }],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "fork_of", reason: "fork" },
      ],
    };
    expect(() => validateMantleConfig(config, trackedProjects, true)).toThrow(
      /impactCheck.enabled=true.*repoUrl/
    );
  });

  it("throws hard error when enabled=true and referenced target has non-github.com repoUrl", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: [], repoUrl: "https://gitlab.com/mantle/reth" }],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "fork_of", reason: "fork" },
      ],
    };
    expect(() => validateMantleConfig(config, trackedProjects, true)).toThrow(
      /impactCheck.enabled=true.*repoUrl/
    );
  });

  it("does not throw when enabled=false even if repoUrl is missing", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: [] }],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "fork_of", reason: "fork" },
      ],
    };
    expect(() => validateMantleConfig(config, trackedProjects, false)).not.toThrow();
  });

  it("warns when impact check is enabled and source is not in tracked projects", () => {
    const config: MantleConfig = {
      mantleTargets: [validTarget],
      counterpartRelationships: [
        { source: "untracked/repo", targets: ["mantle/reth"], relationship: "fork_of", reason: "x" },
      ],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    validateMantleConfig(config, trackedProjects, true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("not in tracked projects"));
    warnSpy.mockRestore();
  });

  it("does not warn for untracked relationship sources while impact check is disabled", () => {
    const config: MantleConfig = {
      mantleTargets: [validTarget],
      counterpartRelationships: [
        { source: "untracked/repo", targets: ["mantle/reth"], relationship: "fork_of", reason: "x" },
      ],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    validateMantleConfig(config, trackedProjects, false);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("not in tracked projects"));
    warnSpy.mockRestore();
  });

  it("does not warn when source is tracked", () => {
    const config: MantleConfig = {
      mantleTargets: [validTarget],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "fork_of", reason: "x" },
      ],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    validateMantleConfig(config, trackedProjects, false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("warns when protocol_dependency target has empty architectureNotes", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: [], repoUrl: "https://github.com/mantleio/reth", architectureNotes: "" }],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "protocol_dependency", reason: "x" },
      ],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    validateMantleConfig(config, trackedProjects, false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("architectureNotes"));
    warnSpy.mockRestore();
  });

  it("warns when protocol_dependency target has absent architectureNotes", () => {
    const config: MantleConfig = {
      mantleTargets: [{ projectId: "mantle/reth", tags: [], repoUrl: "https://github.com/mantleio/reth" }],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "protocol_dependency", reason: "x" },
      ],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    validateMantleConfig(config, trackedProjects, false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("architectureNotes"));
    warnSpy.mockRestore();
  });

  it("does not warn for protocol_dependency with architectureNotes populated", () => {
    const config: MantleConfig = {
      mantleTargets: [validTarget],
      counterpartRelationships: [
        { source: "org/source-repo", targets: ["mantle/reth"], relationship: "protocol_dependency", reason: "x" },
      ],
    };
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    validateMantleConfig(config, trackedProjects, false);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
