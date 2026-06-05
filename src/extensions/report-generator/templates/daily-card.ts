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

export function resolveHeaderTemplate(analyses: GroupedAnalyses): string {
  let hasNotable = false;
  for (const project of analyses) {
    for (const pr of project.prs) {
      if (pr.significance === "directional_shift") return "orange";
      if (pr.significance === "notable") hasNotable = true;
    }
  }
  return hasNotable ? "yellow" : "blue";
}

function significanceBadge(significance: ProjectAnalysis["prs"][number]["significance"]): string {
  if (significance === "directional_shift") return "🔴 DIRECTIONAL";
  if (significance === "notable") return "🟡 NOTABLE";
  return "⚪ ROUTINE";
}

function projectSignificanceRank(project: ProjectAnalysis): number {
  if (project.directionalShiftCount > 0) return 0;
  if (project.notableCount > 0) return 1;
  return 2;
}

export function buildSummaryContent(
  analyses: GroupedAnalyses,
  options?: { partialWarning?: string; budgetLine?: string }
): string {
  const { partialWarning, budgetLine } = options ?? {};

  // Metric summary line
  const repoCount = analyses.length;
  let totalPr = 0;
  let directionalCount = 0;
  let notableCount = 0;
  let routineCount = 0;
  for (const project of analyses) {
    totalPr += project.prCount;
    directionalCount += project.directionalShiftCount;
    notableCount += project.notableCount;
    routineCount += project.prCount - project.directionalShiftCount - project.notableCount;
  }

  const metricParts: string[] = [`${repoCount} repos`, `${totalPr} PR`];
  if (directionalCount > 0) metricParts.push(`🔴 ×${directionalCount}`);
  if (notableCount > 0) metricParts.push(`🟡 ×${notableCount}`);
  if (routineCount > 0) metricParts.push(`⚪ ×${routineCount}`);
  const metricLine = metricParts.join(" · ");

  // Signal table sorted by significance: directional_shift > notable > routine-only
  const sortedProjects = [...analyses].sort(
    (a, b) => projectSignificanceRank(a) - projectSignificanceRank(b)
  );

  const signalRows: string[] = [];
  for (const project of sortedProjects) {
    const rank = projectSignificanceRank(project);
    if (rank === 2) {
      const routinePrCount = project.prCount - project.directionalShiftCount - project.notableCount;
      signalRows.push(`⚪ ${project.projectId} — ${routinePrCount} routine PR`);
    } else {
      const emoji = rank === 0 ? "🔴" : "🟡";
      const targetSig: "directional_shift" | "notable" =
        rank === 0 ? "directional_shift" : "notable";
      // Take first PR in array at the highest significance level
      const targetPr = project.prs.find((pr) => pr.significance === targetSig)!;
      const rawSignal = targetPr.directionSignal ?? targetPr.summary;
      const strippedSignal = stripCounterpartRecommendations(rawSignal);
      let signal = strippedSignal.length > 60 ? `${strippedSignal.slice(0, 60)}…` : strippedSignal;
      signalRows.push(`${emoji} **${project.projectId}** — ${signal}`);
    }
  }

  const signalTable =
    signalRows.length > 0 ? signalRows.join("\n") : "_No projects to display._";

  // Element order: partial warning → metric line → budget warning → signal table
  const parts: string[] = [];
  if (partialWarning) parts.push(`⚠ ${partialWarning}`);
  parts.push(metricLine);
  if (budgetLine?.includes("⚠")) parts.push(budgetLine);
  parts.push(signalTable);

  return parts.join("\n");
}

export function buildRepoPanels(analyses: GroupedAnalyses): LarkElement[] {
  const directionalProjects = analyses.filter((p) => p.directionalShiftCount > 0);
  const notableOnlyProjects = analyses.filter(
    (p) => p.directionalShiftCount === 0 && p.notableCount > 0
  );

  if (directionalProjects.length === 0 && notableOnlyProjects.length === 0) {
    return [{ tag: "markdown", content: "_All PRs are routine today._" }];
  }

  const hasDirectionalPanels = directionalProjects.length > 0;

  // Determine which notable-only panels expand: sort by notableCount desc → prCount desc → original order
  const indexedNotable = notableOnlyProjects.map((p, i) => ({ p, i }));
  indexedNotable.sort((a, b) => {
    if (b.p.notableCount !== a.p.notableCount) return b.p.notableCount - a.p.notableCount;
    if (b.p.prCount !== a.p.prCount) return b.p.prCount - a.p.prCount;
    return a.i - b.i;
  });

  const expandedNotable = new Set<string>();
  if (!hasDirectionalPanels) {
    const expandCount = Math.min(2, indexedNotable.length);
    for (let i = 0; i < expandCount; i++) {
      expandedNotable.add(indexedNotable[i]!.p.projectId);
    }
  }

  const panels: LarkElement[] = [];
  for (const project of analyses) {
    const isDirectional = project.directionalShiftCount > 0;
    const isNotableOnly = project.directionalShiftCount === 0 && project.notableCount > 0;
    if (!isDirectional && !isNotableOnly) continue;

    const emoji = isDirectional ? "🔴" : "🟡";
    const expanded = isDirectional ? true : expandedNotable.has(project.projectId);

    const significantPrs = project.prs.filter((pr) => pr.significance !== "routine");
    const routinePrs = project.prs.filter((pr) => pr.significance === "routine");

    const bodyParts: string[] = [];
    for (const pr of significantPrs) {
      const directionSignal = pr.directionSignal
        ? stripCounterpartRecommendations(pr.directionSignal)
        : null;
      bodyParts.push(`\n${formatMarkdownLink(`#${pr.prNumber} ${pr.title}`, pr.htmlUrl)}`);
      bodyParts.push(`${significanceBadge(pr.significance)} — ${pr.summary}`);
      if (directionSignal) {
        bodyParts.push(`Direction: ${directionSignal}`);
      }
    }
    if (routinePrs.length > 0) {
      bodyParts.push(`_${routinePrs.length} routine PR${routinePrs.length !== 1 ? "s" : ""} not expanded_`);
    }

    panels.push({
      tag: "collapsible_panel",
      expanded,
      header: {
        title: {
          tag: "plain_text",
          content: `${emoji} ${project.projectId} · ${project.prCount} PR`,
        },
      },
      elements: [{ tag: "markdown", content: bodyParts.join("\n").trim() || "_No details available._" }],
    });
  }

  return panels;
}

export function buildDailyCard(
  date: string,
  projectAnalyses: GroupedAnalyses,
  partialWarning?: string,
  budgetLine?: string
): LarkCard {
  const summaryContent = buildSummaryContent(projectAnalyses, { partialWarning, budgetLine });

  const elements: LarkElement[] = [
    { tag: "markdown", content: summaryContent },
    { tag: "hr" },
    ...buildRepoPanels(projectAnalyses),
  ];

  // Budget dedup: warning budget is in summary area; non-warning budget goes to card bottom only
  if (budgetLine && !budgetLine.includes("⚠")) {
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
      template: resolveHeaderTemplate(projectAnalyses),
    },
    elements,
  };
}
