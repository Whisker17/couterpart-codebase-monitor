import type { LarkCard, LarkElement } from "../report-generator/templates/lark-card";

const IMPACT_TYPE_LABELS: Record<string, string> = {
  bug_also_present: "Bug 复现",
  breaking_change: "破坏性变更",
  downtime_risk: "停机风险",
  behavior_change: "行为变更",
  not_affected: "不受影响",
};

const CARD_SIZE_LIMIT_BYTES = 20 * 1024;
const SNIPPET_MAX_LINES = 10;

export interface AlertCardInput {
  checkId: number;
  verdict: {
    affected: string;
    impactType: string;
    evidenceKind: string;
    evidence: Array<{ file: string; lines: string; snippet: string; note: string }>;
    confidence: string;
    summary: string;
    recommendedAction: string;
  };
  prNumber: number;
  prTitle: string;
  sourceProjectId: string;
  targetProjectId: string;
  targetCommit: string;
  checkedAt?: string;
}

function truncateSnippet(snippet: string): string {
  const lines = snippet.split("\n");
  if (lines.length <= SNIPPET_MAX_LINES) return snippet;
  return lines.slice(0, SNIPPET_MAX_LINES).join("\n") + "\n...";
}

function buildEvidenceMarkdown(
  evidence: AlertCardInput["verdict"]["evidence"]
): string {
  if (evidence.length === 0) return "";
  const parts = evidence.map(
    (e) => `• \`${e.file}:${e.lines}\` — ${e.note}\n\`\`\`\n${truncateSnippet(e.snippet)}\n\`\`\``
  );
  return "**证据:**\n" + parts.join("\n");
}

function assembleCard(
  input: AlertCardInput,
  evidence: AlertCardInput["verdict"]["evidence"]
): LarkCard {
  const impactLabel =
    IMPACT_TYPE_LABELS[input.verdict.impactType] ?? input.verdict.impactType;
  const prUrl = `https://github.com/${input.sourceProjectId}/pull/${input.prNumber}`;
  const shortCommit = input.targetCommit.slice(0, 8);
  const date = input.checkedAt ?? new Date().toISOString().slice(0, 10);

  const upstreamLine = `**上游**: [${input.sourceProjectId}#${input.prNumber}](${prUrl}) — ${input.prTitle}`;
  const affectsLine = `**影响**: ${input.targetProjectId} @ \`${shortCommit}\``;
  const evidenceMd = buildEvidenceMarkdown(evidence);
  const footerLine = `confidence: ${input.verdict.confidence} · evidence: ${input.verdict.evidenceKind} · check #${input.checkId} · ${date}`;

  const elements: LarkElement[] = [
    { tag: "markdown", content: `${upstreamLine}\n${affectsLine}` },
    { tag: "hr" },
    { tag: "markdown", content: input.verdict.summary },
  ];

  if (evidenceMd) {
    elements.push({ tag: "markdown", content: evidenceMd });
  }

  elements.push(
    { tag: "markdown", content: `**建议动作**: ${input.verdict.recommendedAction}` },
    { tag: "hr" },
    { tag: "markdown", content: footerLine }
  );

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🚨 Mantle 影响告警: ${impactLabel}` },
      template: "red",
    },
    elements,
  };
}

/**
 * Renders a Lark alert card JSON string for an impact check result.
 * Returns null if the check does not meet the alert threshold
 * (affected=yes && confidence=high).
 * If the rendered JSON exceeds 20 KB, evidence is trimmed to the first
 * two items to stay safely below Lark's 30 KB card limit.
 */
export function renderAlertCard(input: AlertCardInput): string | null {
  if (input.verdict.affected !== "yes" || input.verdict.confidence !== "high") {
    return null;
  }

  const card = assembleCard(input, input.verdict.evidence);
  const json = JSON.stringify(card);

  if (Buffer.byteLength(json, "utf-8") <= CARD_SIZE_LIMIT_BYTES) {
    return json;
  }

  const trimmedCard = assembleCard(input, input.verdict.evidence.slice(0, 2));
  return JSON.stringify(trimmedCard);
}
