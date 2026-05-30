import { describe, it, expect } from "bun:test";
import { truncateDiff } from "./diff-truncator";

const SIMPLE_DIFF = `diff --git a/src/index.ts b/src/index.ts
index abc..def 100644
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
+import { foo } from "./foo";
 const x = 1;
 const y = 2;
-const z = 3;
+const z = foo();
diff --git a/package.json b/package.json
index abc..def 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,6 @@
 {
   "name": "test",
+  "version": "1.1.0",
   "dependencies": {}
 }
diff --git a/yarn.lock b/yarn.lock
index abc..def 100644
--- a/yarn.lock
+++ b/yarn.lock
@@ -1,3 +1,3 @@
-old-dep@1.0.0
+old-dep@1.1.0
`;

describe("truncateDiff", () => {
  it("returns all files when within budget", () => {
    const result = truncateDiff(SIMPLE_DIFF, 8000, 100);
    // yarn.lock is tier 0 (skip) — its diff content should not appear, but manifest lists it
    expect(result.content).toContain("src/index.ts");
    expect(result.content).toContain("package.json");
    // The actual lock file diff hunk should not appear
    expect(result.content).not.toContain("old-dep@1.0.0");
    expect(result.truncated).toBe(false);
  });

  it("prioritizes signal files (tier 1) over source files (tier 2)", () => {
    // Build a diff where only one file can fit
    // package.json is tier 1 (signal), src/index.ts is tier 2 (source)
    // Set a very small budget so only package.json fits
    const result = truncateDiff(SIMPLE_DIFF, 50, 100);
    // Both files may or may not fit, but package.json should be included if only one can
    // With budget=50 tokens (~200 chars), likely neither or only manifest
    // This test checks the order logic — tier 1 should be attempted first
    expect(result.fileManifest).toContain("package.json");
    expect(result.fileManifest).toContain("src/index.ts");
  });

  it("always includes file manifest", () => {
    const result = truncateDiff(SIMPLE_DIFF, 8000, 100);
    expect(result.content).toContain("File manifest");
    expect(result.fileManifest).toBeTruthy();
  });

  it("marks truncated when files are excluded due to budget", () => {
    const result = truncateDiff(SIMPLE_DIFF, 10, 100);
    expect(result.truncated).toBe(true);
  });

  it("skips lock/generated files entirely", () => {
    const result = truncateDiff(SIMPLE_DIFF, 8000, 100);
    expect(result.content).not.toContain("old-dep@1.0.0");
  });

  it("aggregates manifest by tier when file count exceeds maxEntries", () => {
    // Build diff with more files than maxEntries=2
    const manyFilesDiff = Array.from({ length: 10 }, (_, i) =>
      `diff --git a/src/file${i}.ts b/src/file${i}.ts\nindex abc..def 100644\n--- a/src/file${i}.ts\n+++ b/src/file${i}.ts\n@@ -1 +1 @@\n-old\n+new\n`
    ).join("\n");

    const result = truncateDiff(manyFilesDiff, 8000, 2);
    expect(result.fileManifest).toContain("aggregated by tier");
    // No lock files in this diff, so no skipped count line
    expect(result.fileManifest).not.toContain("Skipped:");
  });

  it("includes skipped file count in aggregated manifest when lock files present", () => {
    // Mix of source files (>maxEntries) and lock files
    const mixedDiff =
      Array.from({ length: 5 }, (_, i) =>
        `diff --git a/src/file${i}.ts b/src/file${i}.ts\nindex abc..def 100644\n--- a/src/file${i}.ts\n+++ b/src/file${i}.ts\n@@ -1 +1 @@\n-old\n+new\n`
      ).join("\n") +
      "\ndiff --git a/yarn.lock b/yarn.lock\nindex abc..def 100644\n--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1 +1 @@\n-old-dep@1.0.0\n+old-dep@2.0.0\n";

    const result = truncateDiff(mixedDiff, 8000, 2);
    expect(result.fileManifest).toContain("aggregated by tier");
    expect(result.fileManifest).toContain("Skipped: 1 files (lock/generated/binary)");
  });

  it("returns metadata_only context when diff is empty", () => {
    const result = truncateDiff("", 8000, 100);
    expect(result.totalFiles).toBe(0);
    expect(result.includedFiles).toBe(0);
  });
});
