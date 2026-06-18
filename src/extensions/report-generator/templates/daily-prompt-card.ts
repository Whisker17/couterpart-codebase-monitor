import type { LarkCard, LarkElement } from "./lark-card";
import {
  normalizeLarkMarkdown,
  splitMarkdownSections,
  splitMarkdownSubsections,
  type WeeklyPromptSection,
} from "./weekly-prompt-card";

export interface DailyPromptCardInput {
  date: string;
  markdown: string;
  totalPrs: number;
  projectCount: number;
  directionalShiftCount: number;
  notableCount: number;
  routineCount: number;
  notices?: string[];
  projects?: DailyPromptCardProject[];
}

export interface DailyPromptCardProject {
  projectId: string;
  prCount: number;
  directionalShiftCount: number;
  notableCount: number;
  routineCount: number;
  prs: DailyPromptCardPr[];
}

export interface DailyPromptCardPr {
  prNumber: number;
  title: string;
  htmlUrl: string;
  summary: string;
  significance: "routine" | "notable" | "directional_shift";
}

const ALL_PR_SECTION_KEYS = new Set(["全部pr", "所有pr", "allpr", "allprs"]);
const OVERVIEW_SECTION_KEYS = new Set(["总览", "概览", "今日总览", "日报总览"]);
const FOCUSED_PR_SECTION_KEYS = new Set(["重点pr解读", "重点pr", "重点pr解析"]);

function titleKey(title: string): string {
  return title.replace(/\s+/g, "").trim().toLowerCase();
}

function isAllPrSection(section: WeeklyPromptSection): boolean {
  return ALL_PR_SECTION_KEYS.has(titleKey(section.title));
}

function isOverviewSection(section: WeeklyPromptSection): boolean {
  return OVERVIEW_SECTION_KEYS.has(titleKey(section.title));
}

function isFocusedPrSection(section: WeeklyPromptSection): boolean {
  return FOCUSED_PR_SECTION_KEYS.has(titleKey(section.title));
}

function resolveHeaderTemplate(input: DailyPromptCardInput): string {
  if (input.directionalShiftCount > 0) return "orange";
  if (input.notableCount > 0) return "yellow";
  return "blue";
}

function visibleMetricLine(input: DailyPromptCardInput): string {
  const lines = [
    `**范围**：${input.totalPrs} 个 PR · ${input.projectCount} 个项目`,
    `🔴 ${input.directionalShiftCount} · 🟡 ${input.notableCount} · ⚪ ${input.routineCount}`,
  ];
  for (const notice of input.notices ?? []) {
    const normalized = notice.trim();
    if (normalized) lines.push(`⚠ ${normalized}`);
  }
  return lines.join("\n");
}

function stripMarkdownDividers(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*-{3,}\s*$/.test(line))
    .join("\n");
}

function removeDuplicatedOverviewMetrics(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/(?:昨天|昨日|当日|\d{4}-\d{2}-\d{2}).*(?:共|合并|跟踪|覆盖).*(?:PR|仓库|项目)/i.test(trimmed)) return false;
      if (/^\s*[-*]\s*\*\*?指标[:：]/.test(trimmed)) return false;
      if (/^\s*[-*]\s*指标[:：]/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function organizationName(projectId: string): string {
  const org = projectId.split("/")[0] || projectId;
  return org === "ethereum-optimism" ? "optimism" : org;
}

function overviewAliases(projectId: string): Set<string> {
  const org = projectId.split("/")[0] || projectId;
  return new Set([titleKey(projectId), titleKey(org), titleKey(organizationName(projectId))]);
}

function overviewProjectsForTitle(
  title: string,
  projects: DailyPromptCardProject[] | undefined
): DailyPromptCardProject[] {
  if (!projects) return [];
  const key = titleKey(title);
  return projects.filter((project) => overviewAliases(project.projectId).has(key));
}

function groupedOverviewProjects(
  projects: DailyPromptCardProject[] | undefined
): Array<{ title: string; projects: DailyPromptCardProject[] }> {
  if (!projects) return [];

  const groups = new Map<string, DailyPromptCardProject[]>();
  for (const project of projects) {
    const title = organizationName(project.projectId);
    const group = groups.get(title) ?? [];
    group.push(project);
    groups.set(title, group);
  }
  return Array.from(groups.entries()).map(([title, groupProjects]) => ({
    title,
    projects: groupProjects,
  }));
}

function overviewPrSummary(
  pr: DailyPromptCardPr,
  prSummaries: Map<number, string> | undefined
): string {
  return truncateSummary(prSummaries?.get(pr.prNumber) ?? pr.summary, 74);
}

function formatOverviewProject(
  project: DailyPromptCardProject,
  prSummaries: Map<number, string> | undefined
): string {
  const counts = [
    project.directionalShiftCount > 0 ? `🔴 ${project.directionalShiftCount}` : "",
    project.notableCount > 0 ? `🟡 ${project.notableCount}` : "",
    project.routineCount > 0 ? `⚪ ${project.routineCount}` : "",
  ].filter(Boolean);
  const countPart = counts.length > 0 ? `（${counts.join(" · ")}）` : "";
  const importantPrs = project.prs.filter((pr) => pr.significance !== "routine").slice(0, 2);
  const representativePrs = importantPrs.length > 0 ? importantPrs : project.prs.slice(0, 1);
  const [primary, secondary] = representativePrs;

  if (!primary) return `${project.projectId}：${project.prCount} 个 PR${countPart}。`;

  const primarySummary = overviewPrSummary(primary, prSummaries);
  const secondarySummary = secondary ? overviewPrSummary(secondary, prSummaries) : "";
  const focus = secondarySummary
    ? `，主线是${primarySummary}；同时推进${secondarySummary}。`
    : `，主线是${primarySummary}。`;

  return `${project.projectId}：${project.prCount} 个 PR${countPart}${focus}`;
}

function formatOverviewFallback(
  projects: DailyPromptCardProject[],
  prSummariesByProject: Map<string, Map<number, string>>
): string {
  return projects
    .map((project) => formatOverviewProject(project, prSummariesByProject.get(project.projectId)))
    .join("\n");
}

function overviewPreamble(markdown: string): string {
  const lines: string[] = [];
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^###\s+/.test(line)) break;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

function overviewContentWithFallback(
  content: string,
  projects: DailyPromptCardProject[] | undefined,
  allPrSection?: WeeklyPromptSection
): string {
  const cleaned = stripMarkdownDividers(removeDuplicatedOverviewMetrics(content));
  if (!projects || projects.length === 0) return cleaned || "_本节暂无内容。_";
  const prSummariesByProject = collectMarkdownPrSummaries(allPrSection);

  const subsections = splitMarkdownSubsections(cleaned);
  if (subsections.length === 0) {
    const fallback = groupedOverviewProjects(projects)
      .map((group) => [`### ${group.title}`, formatOverviewFallback(group.projects, prSummariesByProject)].join("\n"))
      .join("\n\n");
    return [cleaned.trim(), fallback].filter(Boolean).join("\n\n");
  }

  const rendered: string[] = [];
  const preamble = overviewPreamble(cleaned);
  if (preamble) rendered.push(preamble);

  const coveredProjectIds = new Set<string>();
  for (const subsection of subsections) {
    const matchedProjects = overviewProjectsForTitle(subsection.title, projects);
    for (const project of matchedProjects) coveredProjectIds.add(project.projectId);

    const fallback =
      matchedProjects.length > 0 ? formatOverviewFallback(matchedProjects, prSummariesByProject) : "";
    rendered.push([`### ${subsection.title}`, subsection.content.trim() || fallback || "_暂无重点变化。_"].join("\n"));
  }

  for (const group of groupedOverviewProjects(projects)) {
    const missingProjects = group.projects.filter((project) => !coveredProjectIds.has(project.projectId));
    if (missingProjects.length === 0) continue;
    rendered.push([`### ${group.title}`, formatOverviewFallback(missingProjects, prSummariesByProject)].join("\n"));
  }

  return rendered.join("\n\n").trim();
}

function renderVisibleSection(
  section: WeeklyPromptSection,
  projects?: DailyPromptCardProject[],
  allPrSection?: WeeklyPromptSection
): LarkElement {
  const rawContent = isOverviewSection(section)
    ? overviewContentWithFallback(section.content, projects, allPrSection)
    : section.content;
  const content = normalizeLarkMarkdown(stripMarkdownDividers(rawContent || "_本节暂无内容。_"));
  return {
    tag: "markdown",
    content: [`**${section.title}**`, content].join("\n"),
  };
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") && trimmed.includes("|");
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function headerKey(header: string): string {
  return header.replace(/\s+/g, "").replace(/[：:]/g, "").trim().toLowerCase();
}

function tableValue(
  headers: string[],
  cells: string[],
  preferredHeaders: string[],
  fallbackIndex: number
): string {
  const preferred = new Set(preferredHeaders.map(headerKey));
  const index = headers.findIndex((header) => preferred.has(headerKey(header)));
  return cells[index >= 0 ? index : fallbackIndex]?.trim() ?? "";
}

function renderPrTableRows(headers: string[], rowLines: string[]): string {
  const renderedRows: string[] = [];

  for (const rowLine of rowLines) {
    const cells = splitTableCells(rowLine);
    const importance = tableValue(headers, cells, ["重要性", "importance"], 0);
    const pr = tableValue(headers, cells, ["PR", "pull request"], 1);
    const summary = tableValue(headers, cells, ["一句话总结", "摘要", "summary"], 2);
    const titleLine = [importance, pr].filter(Boolean).join(" ").trim();

    if (!titleLine && !summary) continue;
    renderedRows.push(summary ? `- ${titleLine}：${summary}`.trim() : `- ${titleLine}`);
  }

  return renderedRows.join("\n\n");
}

function normalizeDailyPrTables(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const normalized: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i]!;
    const separatorLine = lines[i + 1];
    if (
      isMarkdownTableRow(headerLine) &&
      separatorLine !== undefined &&
      isMarkdownTableSeparator(separatorLine)
    ) {
      const headers = splitTableCells(headerLine);
      i += 2;

      const rowLines: string[] = [];
      while (i < lines.length && isMarkdownTableRow(lines[i]!)) {
        rowLines.push(lines[i]!);
        i++;
      }

      const renderedRows = renderPrTableRows(headers, rowLines);
      if (renderedRows) normalized.push(renderedRows);

      if (i < lines.length && lines[i]!.trim() !== "") normalized.push("");
      i--;
      continue;
    }

    normalized.push(headerLine);
  }

  return normalized.join("\n");
}

function normalizeAllPrContent(content: string): string {
  return normalizeLarkMarkdown(
    normalizeDailyPrTables(stripMarkdownDividers(content || "_本 repo 暂无 PR。_"))
  );
}

function significanceBall(significance: DailyPromptCardPr["significance"]): string {
  if (significance === "directional_shift") return "🔴";
  if (significance === "notable") return "🟡";
  return "⚪";
}

function markdownLink(label: string, url: string): string {
  const safeLabel = label.replace(/\s+/g, " ").trim().replace(/[[\]]/g, (ch) => `\\${ch}`);
  return url ? `[${safeLabel}](${url})` : safeLabel;
}

function truncateSummary(summary: string, maxChars = 90): string {
  const normalized = summary.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function parsePrNumberFromMarkdown(markdown: string): number | null {
  const match = markdown.match(/#(\d+)/);
  return match ? Number(match[1]) : null;
}

function directionalPrs(projects: DailyPromptCardProject[] | undefined): DailyPromptCardPr[] {
  if (!projects) return [];
  return projects.flatMap((project) =>
    project.prs.filter((pr) => pr.significance === "directional_shift")
  );
}

function directionalPrNumberSet(projects: DailyPromptCardProject[] | undefined): Set<number> {
  return new Set(directionalPrs(projects).map((pr) => pr.prNumber));
}

function collectMarkdownPrSummaries(section: WeeklyPromptSection | undefined): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>();
  if (!section) return result;

  for (const repo of splitMarkdownSubsections(section.content)) {
    const repoSummaries = new Map<number, string>();
    const lines = repo.content.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const listPrNumber = parsePrNumberFromMarkdown(lines[i]!);
      const summarySeparator = lines[i]!.indexOf("：") >= 0 ? lines[i]!.indexOf("：") : lines[i]!.indexOf(":");
      if (listPrNumber && summarySeparator >= 0) {
        const summary = lines[i]!.slice(summarySeparator + 1).trim();
        if (summary) repoSummaries.set(listPrNumber, summary);
      }

      const headerLine = lines[i]!;
      const separatorLine = lines[i + 1];
      if (!isMarkdownTableRow(headerLine) || !separatorLine || !isMarkdownTableSeparator(separatorLine)) {
        continue;
      }

      const headers = splitTableCells(headerLine);
      i += 2;
      while (i < lines.length && isMarkdownTableRow(lines[i]!)) {
        const cells = splitTableCells(lines[i]!);
        const pr = tableValue(headers, cells, ["PR", "pull request"], 1);
        const summary = tableValue(headers, cells, ["一句话总结", "摘要", "summary", "简介"], 2);
        const prNumber = parsePrNumberFromMarkdown(pr);
        if (prNumber && summary) repoSummaries.set(prNumber, summary);
        i++;
      }
    }
    result.set(repo.title, repoSummaries);
  }

  return result;
}

function buildPrListContent(
  markdownSummaries: Map<number, string>,
  prs: DailyPromptCardPr[]
): string {
  if (prs.length === 0) return "_本 repo 暂无 PR。_";

  return prs
    .map((pr) => {
      const link = markdownLink(`#${pr.prNumber} ${pr.title}`, pr.htmlUrl);
      const summary = truncateSummary(markdownSummaries.get(pr.prNumber) ?? pr.summary);
      return `- ${significanceBall(pr.significance)} ${link}：${summary}`;
    })
    .join("\n");
}

function buildStructuredAllPrElements(
  section: WeeklyPromptSection,
  projects: DailyPromptCardProject[]
): LarkElement[] {
  const elements: LarkElement[] = [{ tag: "markdown", content: `**${section.title}**` }];
  const prSummaries = collectMarkdownPrSummaries(section);

  for (const project of projects) {
    elements.push(
      buildCollapsedRepoPanel(
        project.projectId,
        buildPrListContent(prSummaries.get(project.projectId) ?? new Map<number, string>(), project.prs)
      )
    );
  }

  return elements;
}

function buildCollapsedRepoPanel(title: string, content: string): LarkElement {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: {
        tag: "plain_text",
        content: title,
      },
    },
    elements: [
      {
        tag: "markdown",
        content: normalizeAllPrContent(content),
      },
    ],
  };
}

function buildAllPrElements(section: WeeklyPromptSection): LarkElement[] {
  const elements: LarkElement[] = [
    {
      tag: "markdown",
      content: `**${section.title}**`,
    },
  ];

  const repoSections = splitMarkdownSubsections(section.content);
  if (repoSections.length === 0) {
    elements.push(buildCollapsedRepoPanel(section.title, section.content));
    return elements;
  }

  for (const repo of repoSections) {
    elements.push(buildCollapsedRepoPanel(repo.title, repo.content));
  }
  return elements;
}

function buildSyntheticAllPrSection(): WeeklyPromptSection {
  return { title: "全部 PR", content: "" };
}

function pushHr(elements: LarkElement[]): void {
  if (elements.at(-1)?.tag !== "hr") elements.push({ tag: "hr" });
}

function stripEngineeringJudgment(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*\*\*(工程判断|工程解读)\*\*[:：]/.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Resolve a focused-PR markdown subsection back to its structured PR so the
// title can show the repo and be a clickable link, independent of how the LLM
// formatted the heading. Match by PR URL first (robust to PR-number collisions
// across repos), then fall back to an unambiguous PR number.
function findFocusedPr(
  itemTitle: string,
  projects: DailyPromptCardProject[] | undefined
): { projectId: string; pr: DailyPromptCardPr } | null {
  const all = (projects ?? []).flatMap((project) =>
    project.prs.map((pr) => ({ projectId: project.projectId, pr }))
  );
  const byUrl = all.find((entry) => entry.pr.htmlUrl && itemTitle.includes(entry.pr.htmlUrl));
  if (byUrl) return byUrl;
  const prNumber = parsePrNumberFromMarkdown(itemTitle);
  if (prNumber !== null) {
    const matches = all.filter((entry) => entry.pr.prNumber === prNumber);
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

function focusedPrTitle(projectId: string, pr: DailyPromptCardPr): string {
  const label = `${projectId} #${pr.prNumber} ${pr.title}`;
  return `${significanceBall(pr.significance)} **${markdownLink(label, pr.htmlUrl)}**`;
}

function renderFocusedPrSection(
  section: WeeklyPromptSection,
  directionalNumbers: Set<number>,
  projects: DailyPromptCardProject[] | undefined
): LarkElement | null {
  const redItems = splitMarkdownSubsections(section.content).filter((item) => {
    if (item.title.includes("🔴")) return true;
    const prNumber = parsePrNumberFromMarkdown(item.title);
    return prNumber !== null && directionalNumbers.has(prNumber);
  });
  if (redItems.length === 0) return null;

  const body = redItems
    .map((item) => {
      const found = findFocusedPr(item.title, projects);
      // Build the title from structured data so the repo is always visible and
      // the title links to the PR; fall back to the raw heading if unmatched.
      const title = found
        ? focusedPrTitle(found.projectId, found.pr)
        : `<font color='red'>**${item.title}**</font>`;
      const content = normalizeLarkMarkdown(stripMarkdownDividers(stripEngineeringJudgment(item.content)));
      return [title, content].filter(Boolean).join("\n");
    })
    .join("\n\n");

  return {
    tag: "markdown",
    content: [`**${section.title}**`, body].join("\n"),
  };
}

function buildStructuredFocusedPrElement(projects: DailyPromptCardProject[] | undefined): LarkElement | null {
  const redPrs = directionalPrs(projects).slice(0, 5);
  if (redPrs.length === 0) return null;

  const projectByPr = new Map<number, string>();
  for (const project of projects ?? []) {
    for (const pr of project.prs) {
      projectByPr.set(pr.prNumber, project.projectId);
    }
  }

  const body = redPrs
    .map((pr) => {
      const projectId = projectByPr.get(pr.prNumber) ?? "unknown";
      return [
        focusedPrTitle(projectId, pr),
        `**变更**：${truncateSummary(pr.summary, 140)}`,
      ].join("\n");
    })
    .join("\n\n");

  return {
    tag: "markdown",
    content: ["**重点 PR 解读**", body].join("\n"),
  };
}

export function buildDailyPromptCard(input: DailyPromptCardInput): LarkCard {
  const elements: LarkElement[] = [
    {
      tag: "markdown",
      content: visibleMetricLine(input),
    },
    { tag: "hr" },
  ];

  const sections = splitMarkdownSections(input.markdown);
  if (sections.length === 0) {
    elements.push(buildCollapsedRepoPanel("日报全文", input.markdown.trim() || "_日报没有生成正文。_"));
  } else {
    let renderedAllPrSection = false;
    let renderedFocusedPrSection = false;
    const redPrNumbers = directionalPrNumberSet(input.projects);
    const allPrSection = sections.find(isAllPrSection);
    for (const section of sections) {
      if (isAllPrSection(section)) {
        renderedAllPrSection = true;
        pushHr(elements);
        if (input.projects && input.projects.length > 0) {
          elements.push(...buildStructuredAllPrElements(section, input.projects));
        } else {
          elements.push(...buildAllPrElements(section));
        }
      } else if (isFocusedPrSection(section)) {
        const focused = renderFocusedPrSection(section, redPrNumbers, input.projects);
        if (focused) {
          renderedFocusedPrSection = true;
          elements.push(focused);
          pushHr(elements);
        }
      } else {
        elements.push(renderVisibleSection(section, input.projects, allPrSection));
        pushHr(elements);
      }
    }

    if (!renderedFocusedPrSection) {
      const focused = buildStructuredFocusedPrElement(input.projects);
      if (focused) {
        const insertIndex = elements.findIndex(
          (element) => element.tag === "markdown" && element.content === "**全部 PR**"
        );
        if (insertIndex >= 0) {
          elements.splice(insertIndex, 0, focused, { tag: "hr" });
        } else {
          pushHr(elements);
          elements.push(focused);
        }
      }
    }

    if (!renderedAllPrSection && input.projects && input.projects.length > 0) {
      pushHr(elements);
      elements.push(...buildStructuredAllPrElements(buildSyntheticAllPrSection(), input.projects));
    }

    if (elements.at(-1)?.tag === "hr") elements.pop();
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Counterpart 日报 · ${input.date}`,
      },
      template: resolveHeaderTemplate(input),
    },
    elements,
  };
}
