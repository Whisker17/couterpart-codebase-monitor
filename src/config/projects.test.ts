import { describe, it, expect, beforeEach } from "bun:test";

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
