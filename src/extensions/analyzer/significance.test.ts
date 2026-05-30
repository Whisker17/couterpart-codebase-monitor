import { describe, it, expect } from "bun:test";
import { preFilterSignificance } from "./significance";

describe("preFilterSignificance", () => {
  it("marks small routine PRs as likely_routine", () => {
    const result = preFilterSignificance({
      title: "fix typo in docs",
      files_changed: 2,
      additions: 10,
      deletions: 5,
    });
    expect(result).toBe("likely_routine");
  });

  it("marks dependency bumps as likely_routine", () => {
    const result = preFilterSignificance({
      title: "bump lodash to 4.18.0",
      files_changed: 1,
      additions: 2,
      deletions: 2,
    });
    expect(result).toBe("likely_routine");
  });

  it("marks large PRs as likely_notable", () => {
    const result = preFilterSignificance({
      title: "refactor auth module",
      files_changed: 15,
      additions: 600,
      deletions: 400,
    });
    expect(result).toBe("likely_notable");
  });

  it("marks PRs with many additions as likely_notable", () => {
    const result = preFilterSignificance({
      title: "add feature X",
      files_changed: 5,
      additions: 600,
      deletions: 10,
    });
    expect(result).toBe("likely_notable");
  });

  it("returns unknown for medium-sized PRs without routine keywords", () => {
    const result = preFilterSignificance({
      title: "implement user login",
      files_changed: 5,
      additions: 100,
      deletions: 20,
    });
    expect(result).toBe("unknown");
  });

  it("handles null stats gracefully", () => {
    const result = preFilterSignificance({
      title: "fix typo",
      files_changed: null,
      additions: null,
      deletions: null,
    });
    // 0 < 3 files and 0 < 50 additions and title matches 'fix typo' → likely_routine
    expect(result).toBe("likely_routine");
  });
});
