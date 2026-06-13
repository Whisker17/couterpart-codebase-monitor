import { describe, it, expect } from "bun:test";
import { renderAlertCard } from "./alert-card";
import type { AlertCardInput } from "./alert-card";

function makeInput(overrides?: Partial<AlertCardInput["verdict"]>): AlertCardInput {
  return {
    checkId: 42,
    verdict: {
      affected: "yes",
      impactType: "behavior_change",
      evidenceKind: "code_evidence",
      evidence: [
        {
          file: "path/to/file.go",
          lines: "120-135",
          snippet: "func foo() {\n  bar()\n}",
          note: "changed behavior",
        },
      ],
      confidence: "high",
      summary: "The target is affected by this change.",
      recommendedAction: "Review and patch the fork.",
      ...overrides,
    },
    prNumber: 1234,
    prTitle: "Fix memory leak in block processor",
    sourceProjectId: "ethereum-optimism/op-geth",
    targetProjectId: "mantle/reth",
    targetCommit: "abc123def456",
    checkedAt: "2026-06-12",
  };
}

describe("renderAlertCard", () => {
  it("returns null when affected is not yes", () => {
    expect(renderAlertCard(makeInput({ affected: "no" }))).toBeNull();
    expect(renderAlertCard(makeInput({ affected: "uncertain" }))).toBeNull();
  });

  it("returns null when confidence is not high", () => {
    expect(renderAlertCard(makeInput({ confidence: "medium" }))).toBeNull();
    expect(renderAlertCard(makeInput({ confidence: "low" }))).toBeNull();
  });

  it("returns valid JSON string for affected=yes confidence=high", () => {
    const result = renderAlertCard(makeInput());
    expect(result).not.toBeNull();
    const card = JSON.parse(result!) as Record<string, unknown>;
    expect(card.config).toBeDefined();
    expect(card.header).toBeDefined();
    expect(card.elements).toBeDefined();
  });

  it("card header uses red template and contains impact type label", () => {
    const result = renderAlertCard(makeInput());
    const card = JSON.parse(result!) as {
      header: { title: { content: string }; template: string };
    };
    expect(card.header.template).toBe("red");
    expect(card.header.title.content).toContain("行为变更");
    expect(card.header.title.content).toContain("🚨 Mantle 影响告警");
  });

  it("card elements contain PR link, target project, and footer with check id", () => {
    const result = renderAlertCard(makeInput());
    const json = result!;
    expect(json).toContain("ethereum-optimism/op-geth#1234");
    expect(json).toContain("mantle/reth");
    expect(json).toContain("check #42");
    expect(json).toContain("2026-06-12");
    expect(json).toContain("abc123de"); // short commit hash (first 8 chars)
  });

  it("card contains the summary and recommendedAction", () => {
    const result = renderAlertCard(makeInput());
    const json = result!;
    expect(json).toContain("The target is affected by this change.");
    expect(json).toContain("Review and patch the fork.");
  });

  it("truncates evidence snippets to 10 lines", () => {
    const longSnippet = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = renderAlertCard(
      makeInput({
        evidence: [
          { file: "main.go", lines: "1-20", snippet: longSnippet, note: "long snippet" },
        ],
      })
    );
    expect(result).not.toBeNull();
    // The snippet should be truncated to 10 lines with "..."
    expect(result!).toContain("...");
    // Should not contain line 11+ (line 11 would be "line 11")
    const card = JSON.parse(result!) as { elements: Array<{ tag: string; content: string }> };
    const evidenceEl = card.elements.find(
      (e) => e.tag === "markdown" && e.content.includes("main.go")
    );
    expect(evidenceEl).toBeDefined();
    const lines = evidenceEl!.content.split("\n").filter((l) => l.startsWith("line "));
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("uses fallback label for unknown impact types", () => {
    const result = renderAlertCard(makeInput({ impactType: "unknown_type" }));
    const card = JSON.parse(result!) as { header: { title: { content: string } } };
    expect(card.header.title.content).toContain("unknown_type");
  });

  it("trims evidence to first 2 items when card body exceeds 20 KB", () => {
    const bigSnippet = "x".repeat(8000);
    const evidence = [
      { file: "a.go", lines: "1-5", snippet: bigSnippet, note: "note a" },
      { file: "b.go", lines: "6-10", snippet: bigSnippet, note: "note b" },
      { file: "c.go", lines: "11-15", snippet: bigSnippet, note: "note c" },
    ];
    const result = renderAlertCard(makeInput({ evidence }));
    expect(result).not.toBeNull();
    const bytes = Buffer.byteLength(result!, "utf-8");
    // Should be trimmed
    const card = JSON.parse(result!) as { elements: Array<{ tag: string; content: string }> };
    const evidenceEl = card.elements.find(
      (e) => e.tag === "markdown" && e.content.includes("证据")
    );
    expect(evidenceEl).toBeDefined();
    // Should contain a.go and b.go but not c.go
    expect(evidenceEl!.content).toContain("a.go");
    expect(evidenceEl!.content).toContain("b.go");
    expect(evidenceEl!.content).not.toContain("c.go");
    // Final card must be within 20KB
    expect(bytes).toBeLessThanOrEqual(20 * 1024);
  });

  it("known impact type labels are correctly mapped", () => {
    const cases: Array<[string, string]> = [
      ["bug_also_present", "Bug 复现"],
      ["breaking_change", "破坏性变更"],
      ["downtime_risk", "停机风险"],
      ["behavior_change", "行为变更"],
      ["not_affected", "不受影响"],
    ];
    for (const [impactType, label] of cases) {
      const result = renderAlertCard(makeInput({ impactType }));
      const card = JSON.parse(result!) as { header: { title: { content: string } } };
      expect(card.header.title.content).toContain(label);
    }
  });

  it("card without evidence still renders (no 证据 section)", () => {
    const result = renderAlertCard(makeInput({ evidence: [] }));
    expect(result).not.toBeNull();
    const card = JSON.parse(result!) as { elements: Array<{ tag: string; content: string }> };
    const evidenceEl = card.elements.find(
      (e) => e.tag === "markdown" && e.content.includes("证据")
    );
    expect(evidenceEl).toBeUndefined();
  });
});
