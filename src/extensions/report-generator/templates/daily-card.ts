export interface LarkText {
  tag: "plain_text" | "lark_md";
  content: string;
}

export interface LarkMarkdownElement {
  tag: "markdown";
  content: string;
}

export interface LarkHrElement {
  tag: "hr";
}

export interface LarkCollapsiblePanel {
  tag: "collapsible_panel";
  expanded: boolean;
  header: { title: LarkText };
  elements: LarkMarkdownElement[];
}

export type LarkElement = LarkMarkdownElement | LarkHrElement | LarkCollapsiblePanel;

export interface LarkCard {
  config: { wide_screen_mode: boolean };
  header: {
    title: LarkText;
    template: string;
  };
  elements: LarkElement[];
}

export interface ProjectAnalysis {
  projectId: string;
  prCount: number;
  directionalShiftCount: number;
  notableCount: number;
  topDirectionSignal: string | null;
  prs: Array<{
    prNumber: number;
    title: string;
    summary: string;
    technicalDetail: string | null;
    significance: "routine" | "notable" | "directional_shift";
    directionSignal: string | null;
  }>;
}

export type GroupedAnalyses = ProjectAnalysis[];

export function buildDailyCard(
  date: string,
  projectAnalyses: GroupedAnalyses,
  partialWarning?: string
): LarkCard {
  const summaryLines: string[] = [];
  if (partialWarning) {
    summaryLines.push(`⚠ ${partialWarning}`);
    summaryLines.push("");
  }

  for (const project of projectAnalyses) {
    const parts: string[] = [`${project.projectId}: ${project.prCount} PR${project.prCount !== 1 ? "s" : ""}`];
    if (project.directionalShiftCount > 0) {
      const signal = project.topDirectionSignal ? ` — ${project.topDirectionSignal}` : "";
      parts.push(`${project.directionalShiftCount} directional shift${signal}`);
    } else if (project.notableCount > 0) {
      parts.push(`${project.notableCount} notable`);
    } else {
      parts.push("routine");
    }
    summaryLines.push(`* ${parts.join(", ")}`);
  }

  const summaryContent = `**Summary**\n${summaryLines.join("\n")}`;

  const detailParts: string[] = [];
  for (const project of projectAnalyses) {
    detailParts.push(`**[${project.projectId}]**`);
    for (const pr of project.prs) {
      const badge = pr.significance === "directional_shift"
        ? "🔴 DIRECTIONAL"
        : pr.significance === "notable"
        ? "🟡 NOTABLE"
        : "⚪ ROUTINE";
      detailParts.push(`\nPR #${pr.prNumber}: ${pr.title}`);
      detailParts.push(`${badge} — ${pr.summary}`);
      if (pr.directionSignal) {
        detailParts.push(`Direction: ${pr.directionSignal}`);
      }
      if (pr.technicalDetail) {
        detailParts.push(`Technical: ${pr.technicalDetail}`);
      }
    }
    detailParts.push("");
  }

  const detailContent = detailParts.join("\n").trim();

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Counterpart Monitor · Daily Digest · ${date}`,
      },
      template: "blue",
    },
    elements: [
      { tag: "markdown", content: summaryContent },
      { tag: "hr" },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: {
          title: { tag: "plain_text", content: "Technical Details" },
        },
        elements: [{ tag: "markdown", content: detailContent || "_No technical details available._" }],
      },
    ],
  };
}
