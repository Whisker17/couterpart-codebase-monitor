import type { LarkCard, LarkElement } from "../report-generator/templates/lark-card";
import { translateToZh, type TranslateSettings, type TranslateDeps } from "./translate";

// Dedicated style for the UPSTREAM-PR IMPACT ALERT card. This is intentionally NOT the daily/weekly
// report card layout — it is a single, high-signal warning a Mantle engineer can read at a glance:
//   what upstream changed → which downstream codebase + exact part → how it bites → what to do.

const IMPACT_TYPE_LABELS: Record<string, string> = {
  bug_also_present: "Bug 复现",
  breaking_change: "破坏性变更",
  downtime_risk: "停机风险",
  behavior_change: "行为变更",
  not_affected: "不受影响",
};

// Severities that warrant a pushed Lark alert. medium/low are persisted and surfaced
// in the daily/weekly digest instead — see impact-alert-severity-bar.
const ALERTABLE_SEVERITIES = new Set(["critical", "high"]);

const SEVERITY_HEADER: Record<string, { label: string; template: "red" | "orange"; zh: string }> = {
  critical: { label: "🚨 严重", template: "red", zh: "严重" },
  high: { label: "⚠️ 高", template: "orange", zh: "高" },
};

const CONFIDENCE_ZH: Record<string, string> = { high: "高", medium: "中", low: "低" };
const DRIFT_ZH: Record<string, string> = { missing: "缺失", "tag-diverged": "标签不一致", present: "已同步" };

const CARD_SIZE_LIMIT_BYTES = 20 * 1024;
const SNIPPET_MAX_LINES = 12;

export interface AlertContractCheck {
  mirror: string;
  member: string;
  serializedKey: string | null;
  expectedTag: string | null;
  observedTag: string | null;
  actual: "missing" | "tag-diverged" | "present";
}

export interface AlertEvidence {
  file: string;
  lines: string;
  snippet: string;
  note: string;
  contractCheck?: AlertContractCheck | null;
}

export interface AlertCardInput {
  checkId: number;
  verdict: {
    affected: string;
    severity: string;
    impactType: string;
    evidenceKind: string;
    evidence: AlertEvidence[];
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
  return lines.slice(0, SNIPPET_MAX_LINES).join("\n") + "\n…";
}

// The single most actionable "which part" pointer: prefer the mirror struct.member, else file:line.
function locationLine(evidence: AlertEvidence[]): string | null {
  const cc = evidence.find((e) => e.contractCheck)?.contractCheck;
  if (cc) {
    const ev = evidence.find((e) => e.contractCheck === cc)!;
    return `\`${ev.file}\` · \`${cc.mirror}.${cc.member}\``;
  }
  if (evidence.length > 0) return `\`${evidence[0]!.file}:${evidence[0]!.lines}\``;
  return null;
}

function buildEvidencePanel(evidence: AlertEvidence[]): LarkElement | null {
  if (evidence.length === 0) return null;
  const parts = evidence.map((e) => {
    const cc = e.contractCheck;
    const gap = cc
      ? `\n　↳ 镜像 \`${cc.mirror}.${cc.member}\`：${DRIFT_ZH[cc.actual] ?? cc.actual}` +
        (cc.actual === "tag-diverged" ? `（实际 \`${cc.observedTag}\` ≠ 期望 \`${cc.expectedTag}\`）` : "")
      : "";
    return `**\`${e.file}:${e.lines}\`** — ${e.note}${gap}\n\`\`\`\n${truncateSnippet(e.snippet)}\n\`\`\``;
  });
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "plain_text", content: "🔍 证据 / 代码定位" } },
    elements: [{ tag: "markdown", content: parts.join("\n\n") }],
  };
}

function assembleCard(input: AlertCardInput, evidence: AlertEvidence[]): LarkCard {
  const v = input.verdict;
  const impactLabel = IMPACT_TYPE_LABELS[v.impactType] ?? v.impactType;
  const sev = SEVERITY_HEADER[v.severity] ?? { label: v.severity, template: "red" as const, zh: v.severity };
  const prUrl = `https://github.com/${input.sourceProjectId}/pull/${input.prNumber}`;
  const shortCommit = input.targetCommit.slice(0, 8);
  const date = input.checkedAt ?? new Date().toISOString().slice(0, 10);
  const loc = locationLine(evidence);
  const confZh = CONFIDENCE_ZH[v.confidence] ?? v.confidence;

  // Scannable field block: upstream → downstream → exact location → classification.
  const facts = [
    `🔗 **上游 PR**：[${input.sourceProjectId}#${input.prNumber}](${prUrl})`,
    `　　${input.prTitle}`,
    `📦 **影响下游**：\`${input.targetProjectId}\` @ \`${shortCommit}\``,
    loc ? `📍 **具体位置**：${loc}` : null,
    `🏷️ **影响类型**：${impactLabel}　｜　严重性：${sev.zh}　｜　置信度：${confZh}`,
  ].filter((x): x is string => x !== null);

  const elements: LarkElement[] = [
    { tag: "markdown", content: facts.join("\n") },
    { tag: "hr" },
    { tag: "markdown", content: `**🧩 影响方式**\n${v.summary}` },
    { tag: "markdown", content: `**✅ 建议动作**\n${v.recommendedAction}` },
  ];

  const panel = buildEvidencePanel(evidence);
  if (panel) elements.push(panel);

  elements.push(
    { tag: "hr" },
    {
      tag: "markdown",
      content: `<font color="grey">check #${input.checkId} · ${date} · 证据 ${v.evidenceKind}</font>`,
    }
  );

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `${sev.label}　Mantle 上游影响告警` },
      template: sev.template,
    },
    elements,
  };
}

function passesGate(v: AlertCardInput["verdict"]): boolean {
  return v.affected === "yes" && v.confidence === "high" && ALERTABLE_SEVERITIES.has(v.severity);
}

function assembleWithinSizeLimit(input: AlertCardInput): string {
  const card = assembleCard(input, input.verdict.evidence);
  const json = JSON.stringify(card);
  if (Buffer.byteLength(json, "utf-8") <= CARD_SIZE_LIMIT_BYTES) return json;
  // Trim evidence to the first 2 items to stay under Lark's card limit.
  return JSON.stringify(assembleCard(input, input.verdict.evidence.slice(0, 2)));
}

/**
 * Render the alert card JSON (synchronous; uses the verdict text as-is).
 * Returns null unless affected=yes && confidence=high && severity ∈ {critical, high}.
 */
export function renderAlertCard(input: AlertCardInput): string | null {
  if (!passesGate(input.verdict)) return null;
  return assembleWithinSizeLimit(input);
}

/**
 * Render the alert card with its free-text fields translated to Simplified Chinese via the LLM
 * gateway (best-effort; falls back to the originals on failure). Use this on the send path so the
 * pushed card is Chinese regardless of whether the verdict text came back in English.
 */
export async function renderAlertCardZh(
  input: AlertCardInput,
  settings: TranslateSettings,
  deps?: TranslateDeps
): Promise<string | null> {
  if (!passesGate(input.verdict)) return null;

  const notes = input.verdict.evidence.map((e) => e.note);
  const [summaryZh, actionZh, ...noteZh] = await translateToZh(
    [input.verdict.summary, input.verdict.recommendedAction, ...notes],
    settings,
    deps
  );

  const translated: AlertCardInput = {
    ...input,
    verdict: {
      ...input.verdict,
      summary: summaryZh ?? input.verdict.summary,
      recommendedAction: actionZh ?? input.verdict.recommendedAction,
      evidence: input.verdict.evidence.map((e, i) => ({ ...e, note: noteZh[i] ?? e.note })),
    },
  };
  return assembleWithinSizeLimit(translated);
}
