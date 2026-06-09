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

export interface LarkTableColumn {
  name: string;
  display_name: string;
  data_type: "text" | "lark_md" | "number" | "options" | "persons" | "date";
  horizontal_align?: "left" | "center" | "right";
  vertical_align?: "top" | "middle" | "bottom";
}

export interface LarkTableElement {
  tag: "table";
  page_size: number;
  row_height: "low" | "middle" | "high" | `${number}px`;
  freeze_first_column?: boolean;
  header_style?: {
    text_align?: "left" | "center" | "right";
    text_size?: "normal" | "heading";
    background_style?: "none" | "grey";
    text_color?: "default" | "grey";
    bold?: boolean;
    lines?: number;
  };
  columns: LarkTableColumn[];
  rows: Array<Record<string, string | number | string[]>>;
}

export type LarkElement =
  | LarkMarkdownElement
  | LarkHrElement
  | LarkCollapsiblePanel
  | LarkTableElement;

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

export function truncateAtSentenceBoundary(text: string, byteCap: number): string {
  if (Buffer.byteLength(text, "utf-8") <= byteCap) {
    return text;
  }

  let byteCount = 0;
  let charLimit = 0;
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, "utf-8");
    if (byteCount + charBytes > byteCap) break;
    byteCount += charBytes;
    charLimit += ch.length; // 1 for BMP code points, 2 for astral (surrogate pairs)
  }

  const substr = text.slice(0, charLimit);
  let lastBoundaryPos = -1;
  for (const marker of ["。", ". ", "！", "! ", "？", "? "]) {
    const idx = substr.lastIndexOf(marker);
    if (idx !== -1) {
      const pos = idx + marker.length;
      if (pos > lastBoundaryPos) lastBoundaryPos = pos;
    }
  }

  if (lastBoundaryPos > charLimit * 0.4) {
    return text.slice(0, lastBoundaryPos).trim();
  }

  return text.slice(0, charLimit).trim() + "…";
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
      let signal = truncateAtSentenceBoundary(strippedSignal, 500);
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

type SignificantTier = "directional" | "notable";
type SignificantPr = ProjectAnalysis["prs"][number] & {
  significance: "directional_shift" | "notable";
};

interface TierRepoGroup {
  projectId: string;
  prCount: number;
  prs: SignificantPr[];
}

function renderPrDetails(prs: SignificantPr[]): string {
  const bodyParts: string[] = [];
  for (const pr of prs) {
    const directionSignal = pr.directionSignal
      ? stripCounterpartRecommendations(pr.directionSignal)
      : null;
    bodyParts.push(`\n${formatMarkdownLink(`#${pr.prNumber} ${pr.title}`, pr.htmlUrl)}`);
    bodyParts.push(`${significanceBadge(pr.significance)} — ${pr.summary}`);
    if (directionSignal) {
      bodyParts.push(`Direction: ${directionSignal}`);
    }
  }

  return bodyParts.join("\n").trim() || "_No details available._";
}

function buildRepoMarkdownSections(groups: TierRepoGroup[]): string {
  return groups
    .map((group) => {
      const header =
        group.prs.length === 1
          ? `**${group.projectId} · 1 PR**`
          : `**${group.projectId} · ${group.prs.length} PR**`;
      return `${header}\n${renderPrDetails(group.prs)}`;
    })
    .join("\n\n---\n\n");
}

function groupProjectsByPrTier(
  analyses: GroupedAnalyses,
  tier: SignificantTier
): TierRepoGroup[] {
  const targetSignificance = tier === "directional" ? "directional_shift" : "notable";
  const groups: TierRepoGroup[] = [];

  for (const project of analyses) {
    const prs = project.prs.filter(
      (pr): pr is SignificantPr => pr.significance === targetSignificance
    );
    if (prs.length === 0) continue;
    groups.push({ projectId: project.projectId, prCount: project.prCount, prs });
  }

  return groups;
}

function buildOuterTierPanel(
  tier: "directional" | "notable",
  groups: TierRepoGroup[],
  expanded: boolean
): LarkCollapsiblePanel {
  const sorted = [...groups].sort((a, b) => {
    if (b.prs.length !== a.prs.length) return b.prs.length - a.prs.length;
    if (b.prCount !== a.prCount) return b.prCount - a.prCount;
    return a.projectId.localeCompare(b.projectId);
  });

  const tierCount = sorted.reduce((sum, p) => sum + p.prs.length, 0);

  const N = sorted.length;
  const emoji = tier === "directional" ? "🔴" : "🟡";
  const tierLabel = tier === "directional" ? "DIRECTIONAL" : "NOTABLE";
  const countLabel = tier === "directional" ? "directional" : "notable";

  const headerContent = `${emoji} ${tierLabel} · ${N} repo${N !== 1 ? "s" : ""} · ${tierCount} ${countLabel}`;

  return {
    tag: "collapsible_panel",
    expanded,
    header: { title: { tag: "plain_text", content: headerContent } },
    elements: [{ tag: "markdown", content: buildRepoMarkdownSections(sorted) }],
  };
}

export function buildSignificancePanels(analyses: GroupedAnalyses): LarkElement[] {
  const directionalProjects = groupProjectsByPrTier(analyses, "directional");
  const notableProjects = groupProjectsByPrTier(analyses, "notable");

  if (directionalProjects.length === 0 && notableProjects.length === 0) {
    return [{ tag: "markdown", content: "_All PRs are routine today._" }];
  }

  const panels: LarkElement[] = [];
  const hasDirectional = directionalProjects.length > 0;

  if (hasDirectional) {
    panels.push(buildOuterTierPanel("directional", directionalProjects, true));
  }
  if (notableProjects.length > 0) {
    panels.push(buildOuterTierPanel("notable", notableProjects, !hasDirectional));
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
    ...buildSignificancePanels(projectAnalyses),
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
