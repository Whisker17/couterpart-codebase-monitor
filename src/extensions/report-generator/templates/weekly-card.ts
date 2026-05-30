import type { LarkCard, LarkElement } from "./daily-card";
import type { WeeklyReportData } from "../weekly";

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
      highlightParts.push(`\nPR #${h.prNumber}: ${h.title}`);
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
