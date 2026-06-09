import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getTrackedProjects,
  reloadTrackedProjects,
  _resetProjectsCache,
  _setProjectsConfigPath,
  normalizeGitHubUrl,
  parseGitHubOrgRepo,
  parseAndValidateProjects,
  projects,
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
    expect(keys).toContain("base/base");
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

describe("parseAndValidateProjects — URL-only subscription entries", () => {
  it("derives org and repo from url", () => {
    const result = parseAndValidateProjects([{ url: "https://github.com/base/base" }]);
    expect(result[0].org).toBe("base");
    expect(result[0].repo).toBe("base");
  });

  it("normalizes http:// subscription url to https://", () => {
    const result = parseAndValidateProjects([{ url: "http://github.com/base/base" }]);
    expect(result[0].url).toBe("https://github.com/base/base");
    expect(result[0].org).toBe("base");
  });

  it("strips trailing slash from subscription url", () => {
    const result = parseAndValidateProjects([{ url: "https://github.com/base/base/" }]);
    expect(result[0].url).toBe("https://github.com/base/base");
  });

  it("strips .git suffix from subscription url", () => {
    const result = parseAndValidateProjects([{ url: "https://github.com/base/base.git" }]);
    expect(result[0].url).toBe("https://github.com/base/base");
    expect(result[0].repo).toBe("base");
  });

  it("defaults tags to [] when not specified", () => {
    const result = parseAndValidateProjects([{ url: "https://github.com/base/base" }]);
    expect(result[0].tags).toEqual([]);
  });

  it("preserves provided tags", () => {
    const result = parseAndValidateProjects([
      { url: "https://github.com/base/base", tags: ["blockchain", "l2"] },
    ]);
    expect(result[0].tags).toEqual(["blockchain", "l2"]);
  });

  it("preserves notes when provided", () => {
    const result = parseAndValidateProjects([
      { url: "https://github.com/base/base", notes: "analyst context" },
    ]);
    expect(result[0].notes).toBe("analyst context");
  });

  it("notes is undefined when not provided", () => {
    const result = parseAndValidateProjects([{ url: "https://github.com/base/base" }]);
    expect(result[0].notes).toBeUndefined();
  });

  it("ignores unknown fields", () => {
    const result = parseAndValidateProjects([
      { url: "https://github.com/base/base", unknownField: "ignored", anotherField: 42 },
    ]);
    expect(result[0].org).toBe("base");
    expect((result[0] as Record<string, unknown>).unknownField).toBeUndefined();
  });
});

describe("parseAndValidateProjects — local JSON backward compat", () => {
  it("accepts entries with explicit org and repo fields", () => {
    const result = parseAndValidateProjects([
      { org: "base", repo: "base", url: "https://github.com/base/base" },
    ]);
    expect(result[0].org).toBe("base");
    expect(result[0].repo).toBe("base");
  });

  it("uses explicit org/repo when both are provided", () => {
    const result = parseAndValidateProjects([
      { org: "myorg", repo: "myrepo", url: "https://github.com/myorg/myrepo", tags: ["tag1"] },
    ]);
    expect(result[0].org).toBe("myorg");
    expect(result[0].repo).toBe("myrepo");
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
});

// ---- projects config object ----

describe("projects.fetchTimeoutMs", () => {
  it("defaults to 10000", () => {
    expect(projects.fetchTimeoutMs).toBe(10000);
  });
});
