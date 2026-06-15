import { describe, it, expect } from "bun:test";
import { renderAlertCard, renderAlertCardZh, type AlertCardInput } from "./alert-card";

function makeInput(overrides?: Partial<AlertCardInput["verdict"]>): AlertCardInput {
  return {
    checkId: 42,
    verdict: {
      affected: "yes",
      severity: "critical",
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

type Card = {
  header: { title: { content: string }; template: string };
  elements: Array<{ tag: string; content?: string; elements?: Array<{ content: string }> }>;
};
// Concatenate all markdown text in the card (top-level + inside collapsible panels).
function allText(card: Card): string {
  return card.elements
    .map((e) => (e.content ?? "") + (e.elements ?? []).map((x) => x.content).join("\n"))
    .join("\n");
}
function panel(card: Card) {
  return card.elements.find((e) => e.tag === "collapsible_panel");
}

describe("renderAlertCard — gate", () => {
  it("returns null when affected is not yes", () => {
    expect(renderAlertCard(makeInput({ affected: "no" }))).toBeNull();
    expect(renderAlertCard(makeInput({ affected: "uncertain" }))).toBeNull();
  });
  it("returns null when confidence is not high", () => {
    expect(renderAlertCard(makeInput({ confidence: "medium" }))).toBeNull();
    expect(renderAlertCard(makeInput({ confidence: "low" }))).toBeNull();
  });
  it("returns null for sub-threshold severities (medium/low)", () => {
    expect(renderAlertCard(makeInput({ severity: "medium" }))).toBeNull();
    expect(renderAlertCard(makeInput({ severity: "low" }))).toBeNull();
  });
  it("renders for critical and high severity", () => {
    expect(renderAlertCard(makeInput({ severity: "critical" }))).not.toBeNull();
    expect(renderAlertCard(makeInput({ severity: "high" }))).not.toBeNull();
  });
});

describe("renderAlertCard — header", () => {
  it("critical => red + 🚨 严重; high => orange + ⚠️ 高; always the alert title", () => {
    const crit = JSON.parse(renderAlertCard(makeInput({ severity: "critical" }))!) as Card;
    expect(crit.header.template).toBe("red");
    expect(crit.header.title.content).toContain("🚨 严重");
    expect(crit.header.title.content).toContain("Mantle 上游影响告警");

    const high = JSON.parse(renderAlertCard(makeInput({ severity: "high" }))!) as Card;
    expect(high.header.template).toBe("orange");
    expect(high.header.title.content).toContain("⚠️ 高");
  });
});

describe("renderAlertCard — body", () => {
  it("shows upstream PR link, downstream target, short commit, location, impact label, severity", () => {
    const card = JSON.parse(renderAlertCard(makeInput())!) as Card;
    const text = allText(card);
    expect(text).toContain("ethereum-optimism/op-geth#1234"); // PR ref
    expect(text).toContain("Fix memory leak in block processor"); // PR title
    expect(text).toContain("mantle/reth"); // downstream target
    expect(text).toContain("abc123de"); // short commit
    expect(text).toContain("path/to/file.go:120-135"); // location (no contractCheck -> file:line)
    expect(text).toContain("行为变更"); // impact label (now in the body, not the header)
    expect(text).toContain("严重性"); // severity field present
  });

  it("contains the summary and recommendedAction", () => {
    const text = allText(JSON.parse(renderAlertCard(makeInput())!) as Card);
    expect(text).toContain("The target is affected by this change.");
    expect(text).toContain("Review and patch the fork.");
  });

  it("footer carries the check id and date", () => {
    const text = allText(JSON.parse(renderAlertCard(makeInput())!) as Card);
    expect(text).toContain("check #42");
    expect(text).toContain("2026-06-12");
  });

  it("uses the fallback label for unknown impact types", () => {
    const text = allText(JSON.parse(renderAlertCard(makeInput({ impactType: "unknown_type" }))!) as Card);
    expect(text).toContain("unknown_type");
  });

  it("maps known impact-type labels", () => {
    for (const [impactType, label] of [
      ["bug_also_present", "Bug 复现"],
      ["breaking_change", "破坏性变更"],
      ["downtime_risk", "停机风险"],
      ["behavior_change", "行为变更"],
    ] as Array<[string, string]>) {
      const text = allText(JSON.parse(renderAlertCard(makeInput({ impactType }))!) as Card);
      expect(text).toContain(label);
    }
  });
});

describe("renderAlertCard — evidence", () => {
  it("puts evidence in a collapsible panel and truncates long snippets", () => {
    const longSnippet = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join("\n");
    const card = JSON.parse(
      renderAlertCard(makeInput({ evidence: [{ file: "main.go", lines: "1-24", snippet: longSnippet, note: "long" }] }))!
    ) as Card;
    const p = panel(card);
    expect(p).toBeDefined();
    const content = p!.elements!.map((x) => x.content).join("\n");
    expect(content).toContain("main.go");
    expect(content).toContain("…"); // truncation marker
    const lineCount = content.split("\n").filter((l) => l.startsWith("line ")).length;
    expect(lineCount).toBeLessThanOrEqual(12);
  });

  it("renders the contractCheck mirror gap + location uses mirror.member", () => {
    const card = JSON.parse(
      renderAlertCard(
        makeInput({
          evidence: [
            {
              file: "op-service/sources/types.go",
              lines: "33-70",
              snippet: "type RPCHeader struct {}",
              note: "镜像漂移",
              contractCheck: {
                mirror: "RPCHeader",
                member: "SlotNumber",
                serializedKey: "slotNumber",
                expectedTag: null,
                observedTag: null,
                actual: "missing",
              },
            },
          ],
        })
      )!
    ) as Card;
    const text = allText(card);
    expect(text).toContain("RPCHeader.SlotNumber"); // location points at the exact part
    expect(text).toContain("缺失"); // missing rendered in Chinese
  });

  it("no evidence => no collapsible panel, still renders", () => {
    const card = JSON.parse(renderAlertCard(makeInput({ evidence: [] }))!) as Card;
    expect(panel(card)).toBeUndefined();
  });

  it("trims evidence to first 2 items when over 20 KB", () => {
    const big = "x".repeat(8000);
    const card = JSON.parse(
      renderAlertCard(
        makeInput({
          evidence: [
            { file: "a.go", lines: "1-5", snippet: big, note: "a" },
            { file: "b.go", lines: "6-10", snippet: big, note: "b" },
            { file: "c.go", lines: "11-15", snippet: big, note: "c" },
          ],
        })
      )!
    ) as Card;
    const content = panel(card)!.elements!.map((x) => x.content).join("\n");
    expect(content).toContain("a.go");
    expect(content).toContain("b.go");
    expect(content).not.toContain("c.go");
  });
});

describe("renderAlertCardZh", () => {
  const settings = { llm: { model: "m", baseUrl: "", apiKey: "test-key" } };

  it("applies the same gate", async () => {
    expect(await renderAlertCardZh(makeInput({ severity: "low" }), settings)).toBeNull();
  });

  it("translates free-text fields via the injected gateway", async () => {
    // 3 pending English fields: summary, recommendedAction, evidence note.
    const fakeGenerateObject: any = async () => ({
      object: { translations: ["目标受此改动影响。", "审查并修补该 fork。", "行为变更"] },
    });
    const json = await renderAlertCardZh(makeInput(), settings, { generateObjectFn: fakeGenerateObject });
    const text = allText(JSON.parse(json!) as Card);
    expect(text).toContain("目标受此改动影响。");
    expect(text).toContain("审查并修补该 fork。");
  });

  it("falls back to originals when translation throws (best-effort)", async () => {
    const fakeGenerateObject: any = async () => {
      throw new Error("gateway down");
    };
    const json = await renderAlertCardZh(makeInput(), settings, { generateObjectFn: fakeGenerateObject });
    const text = allText(JSON.parse(json!) as Card);
    expect(text).toContain("The target is affected by this change.");
  });
});
