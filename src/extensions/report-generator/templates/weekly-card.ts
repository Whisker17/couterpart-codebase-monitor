import type { LarkCard, LarkElement } from "./daily-card";
import { formatMarkdownLink } from "./daily-card";
import type { WeeklyReportData } from "../weekly";
import type { CounterpartCheckItem } from "../counterpart-check";

const MAX_COUNTERPART_ITEMS = 10;

function buildCounterpartChecksContent(checks: CounterpartCheckItem[]): string {
  if (checks.length === 0) {
    return "_No counterpart checks this week._";
  }

  const shown = checks.slice(0, MAX_COUNTERPART_ITEMS);
  const omitted = checks.length - shown.length;

  const riskItems = shown.filter((c) => c.signalType === "risk_signal");
  const optItems = shown.filter((c) => c.signalType === "optimization_opportunity");

  const parts: string[] = [];

  if (riskItems.length > 0) {
    parts.push("**Risk Signals**");
    for (const item of riskItems) {
      parts.push(
        `- ${item.source.projectId}#${item.source.prNumber} → ${item.targetProjectId} [${item.confidence}, ${item.evidenceLabel}]`
      );
      parts.push(`  Why: ${item.whyItMatters}`);
      parts.push(`  Action: ${item.suggestedAction}`);
    }
  }

  if (optItems.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("**Optimization Opportunities**");
    for (const item of optItems) {
      parts.push(
        `- ${item.source.projectId}#${item.source.prNumber} → ${item.targetProjectId} [${item.confidence}, ${item.evidenceLabel}]`
      );
      parts.push(`  Why: ${item.whyItMatters}`);
      parts.push(`  Action: ${item.suggestedAction}`);
    }
  }

  if (omitted > 0) {
    parts.push("");
    parts.push(`_+${omitted} more item${omitted !== 1 ? "s" : ""} not shown_`);
  }

  return parts.join("\n");
}

export function buildWeeklyCard(dateRange: string, data: WeeklyReportData): LarkCard {
  const elements: LarkElement[] = [];

  // Direction Changes section
  let directionContent: string;
  if (data.directionChanges.length === 0) {
    directionContent = "**Direction Changes This Week**\n_No directional shifts detected._";
  } else {
    const lines = data.directionChanges.map((dc) => {
      const prLabel = dc.prCount === 1 ? "1 PR" : `${dc.prCount} PRs`;
      const signalText = dc.signals.length > 0 ? `: ${dc.signals[0]}` : "";
      return `* ${dc.projectId}${signalText} (${prLabel})`;
    });
    directionContent = `**Direction Changes This Week**\n${lines.join("\n")}`;
  }
  elements.push({ tag: "markdown", content: directionContent });
  elements.push({ tag: "hr" });

  // Activity Summary section
  const { totalPrs, directionalShiftCount, notableCount, projectCount } = data.activitySummary;
  const activityLines = [
    `* ${totalPrs} PR${totalPrs !== 1 ? "s" : ""} across ${projectCount} project${projectCount !== 1 ? "s" : ""}`,
    `* ${directionalShiftCount} directional shift${directionalShiftCount !== 1 ? "s" : ""}`,
    `* ${notableCount} notable change${notableCount !== 1 ? "s" : ""}`,
  ];
  elements.push({ tag: "markdown", content: `**Activity Summary**\n${activityLines.join("\n")}` });
  elements.push({ tag: "hr" });

  // Per-project Highlights (collapsible)
  const highlightParts: string[] = [];
  for (const project of data.projectHighlights) {
    highlightParts.push(`**[${project.projectId}]** — ${project.prCount} PR${project.prCount !== 1 ? "s" : ""}`);
    for (const h of project.highlights) {
      const badge =
        h.significance === "directional_shift"
          ? "🔴 DIRECTIONAL"
          : h.significance === "notable"
          ? "🟡 NOTABLE"
          : "⚪ ROUTINE";
      highlightParts.push(`\n${formatMarkdownLink(`PR #${h.prNumber}: ${h.title}`, h.htmlUrl)}`);
      highlightParts.push(`${badge} — ${h.summary}`);
      if (h.directionSignal) {
        highlightParts.push(`Direction: ${h.directionSignal}`);
      }
    }
    highlightParts.push("");
  }

  elements.push({
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "plain_text", content: "Per-project Highlights" } },
    elements: [
      {
        tag: "markdown",
        content: highlightParts.join("\n").trim() || "_No highlights available._",
      },
    ],
  });

  // Mantle Counterpart Checks section
  elements.push({ tag: "hr" });
  elements.push({
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "plain_text", content: "Mantle Counterpart Checks" } },
    elements: [
      {
        tag: "markdown",
        content: buildCounterpartChecksContent(data.counterpartChecks),
      },
    ],
  });

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Counterpart Monitor · Weekly Intelligence · ${dateRange}`,
      },
      template: "purple",
    },
    elements,
  };
}
