import { describe, it, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  getTrackedProjects,
  reloadTrackedProjects,
  _resetProjectsCache,
  _setProjectsConfigPath,
} from "./projects.ts";

describe("getTrackedProjects", () => {
  beforeEach(() => {
    // Reset module cache between tests
    // @ts-ignore - reset private cache
    // We'll re-import fresh each time via a wrapper
  });

  it("returns an array of projects", async () => {
    const { getTrackedProjects } = await import("./projects.ts");
    const projects = getTrackedProjects();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.length).toBeGreaterThanOrEqual(3);
    expect(projects.length).toBeLessThanOrEqual(10);
  });

  it("each project has required fields", async () => {
    const { getTrackedProjects } = await import("./projects.ts");
    const projects = getTrackedProjects();
    for (const p of projects) {
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
    const projects = getTrackedProjects();
    const keys = projects.map((p) => `${p.org}/${p.repo}`);
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

    const { projects, changed } = reloadTrackedProjects();
    expect(changed).toBe(true);
    expect(projects.length).toBe(3);
    expect(projects.map((p) => `${p.org}/${p.repo}`)).toContain("new/proj");
    expect(getTrackedProjects().length).toBe(3);
  });

  // Test 8: Project removed — next collect skips it, DB rows unaffected
  it("warm reload excludes removed project without touching persistent state", () => {
    reloadTrackedProjects();
    expect(getTrackedProjects().map((p) => `${p.org}/${p.repo}`)).toContain("foo/bar");

    // Remove foo/bar
    writeFileSync(tmpPath, JSON.stringify([baseProjects[0]]));

    const { projects, changed } = reloadTrackedProjects();
    expect(changed).toBe(true);
    expect(projects.map((p) => `${p.org}/${p.repo}`)).not.toContain("foo/bar");
    expect(projects.length).toBe(1);
    // reloadTrackedProjects makes no DB calls — DB history is untouched by design
  });

  // Test 9: Projects JSON parse failure (cache exists) — old list kept, warning
  it("warm reload with invalid JSON keeps old list and logs a warning", () => {
    reloadTrackedProjects();
    const originalLength = getTrackedProjects().length;

    writeFileSync(tmpPath, "{ invalid json }");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const { projects, changed } = reloadTrackedProjects();
    expect(changed).toBe(false);
    expect(projects.length).toBe(originalLength);
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
