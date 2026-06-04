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
    htmlUrl: string;
    // Optional fields for weekly scoring — not rendered in Lark delivery
    weeklyCandidateReason?: string;
    candidateTags?: string[];
  }>;
}

export type GroupedAnalyses = ProjectAnalysis[];

export function buildPrHtmlUrl(projectUrl: string, prNumber: number): string {
  return `${projectUrl.replace(/\/+$/, "")}/pull/${prNumber}`;
}

export function formatMarkdownLink(label: string, url: string): string {
  const safeLabel = label
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[[\]]/g, (ch) => `\\${ch}`);
  const safeUrl = url.trim();
  return safeUrl ? `[${safeLabel}](${safeUrl})` : safeLabel;
}

// Strip cross-repo counterpart recommendations from direction signals.
// Daily reports describe the source PR's own direction; cross-repo action
// suggestions ("Mantle should ...", "mantle/reth may need ...") belong in weekly.
export function stripCounterpartRecommendations(text: string): string {
  return text
    .replace(/\b(mantle\/reth|mantle\/[a-z-]+|mantle)\s+should\b[^.!?;\n]*/gi, "")
    .replace(/\b(mantle\/reth|mantle\/[a-z-]+|mantle)\s+may\s+need\b[^.!?;\n]*/gi, "")
    .replace(/\b(mantle\/reth|mantle\/[a-z-]+|mantle)\s+needs?\s+to\b[^.!?;\n]*/gi, "")
    .replace(/;\s*;/g, ";")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function significanceBadge(significance: ProjectAnalysis["prs"][number]["significance"]): string {
  if (significance === "directional_shift") return "🔴 DIRECTIONAL";
  if (significance === "notable") return "🟡 NOTABLE";
  return "⚪ ROUTINE";
}

export function buildDailyCard(
  date: string,
  projectAnalyses: GroupedAnalyses,
  partialWarning?: string,
  budgetLine?: string
): LarkCard {
  // Summary section
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

  // Determine whether notable/directional PRs exist across all projects.
  // The detail panel starts expanded when there is signal worth surfacing.
  const hasSignificantPrs = projectAnalyses.some(
    (p) => p.directionalShiftCount > 0 || p.notableCount > 0
  );

  // Detail section: significant PRs (directional_shift + notable) are shown in full.
  // Routine PRs are never expanded — for routine-only projects one representative
  // is shown compactly with a count note for the rest.
  const detailParts: string[] = [];
  for (const project of projectAnalyses) {
    const significantPrs = project.prs.filter((pr) => pr.significance !== "routine");
    const routinePrs = project.prs.filter((pr) => pr.significance === "routine");

    const visiblePrs = significantPrs.length > 0 ? significantPrs : routinePrs.slice(0, 1);

    if (visiblePrs.length === 0) continue;

    detailParts.push(`**[${project.projectId}]** · ${project.prCount} PR${project.prCount !== 1 ? "s" : ""}`);

    for (const pr of visiblePrs) {
      // Strip cross-repo counterpart recommendations before rendering
      const directionSignal = pr.directionSignal
        ? stripCounterpartRecommendations(pr.directionSignal)
        : null;

      detailParts.push(`\n${formatMarkdownLink(`#${pr.prNumber} ${pr.title}`, pr.htmlUrl)}`);
      detailParts.push(`${significanceBadge(pr.significance)} — ${pr.summary}`);
      if (directionSignal) {
        detailParts.push(`Direction: ${directionSignal}`);
      }
    }

    // Omit notes for routine PRs not shown
    if (significantPrs.length > 0 && routinePrs.length > 0) {
      detailParts.push(`_${routinePrs.length} routine PR${routinePrs.length !== 1 ? "s" : ""} not expanded_`);
    } else if (significantPrs.length === 0 && routinePrs.length > 1) {
      const rest = routinePrs.length - 1;
      detailParts.push(`_${rest} more routine PR${rest !== 1 ? "s" : ""}_`);
    }

    detailParts.push("");
  }

  const detailContent = detailParts.join("\n").trim();

  const elements: LarkElement[] = [
    { tag: "markdown", content: summaryContent },
    { tag: "hr" },
    {
      tag: "collapsible_panel",
      expanded: hasSignificantPrs,
      header: {
        title: { tag: "plain_text", content: hasSignificantPrs ? "Notable PRs" : "PR Details" },
      },
      elements: [{ tag: "markdown", content: detailContent || "_No PRs to display._" }],
    },
  ];

  if (budgetLine) {
    elements.push({ tag: "hr" });
    elements.push({ tag: "markdown", content: budgetLine });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Counterpart Monitor · Daily Digest · ${date}`,
      },
      template: "blue",
    },
    elements,
  };
}
