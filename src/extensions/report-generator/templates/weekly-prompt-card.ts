import type { LarkCard, LarkElement, LarkText } from "./daily-card";

export interface WeeklyPromptSection {
  title: string;
  content: string;
}

export interface WeeklyPromptSubsection {
  title: string;
  content: string;
}

export interface WeeklyPromptCardInput {
  dateRange: string;
  markdown: string;
  totalPrs: number;
  projectCount: number;
}

const ACTION_SECTION_TITLES = new Set(["优先跟进事项", "Action Items", "优先跟进"]);

function stripHeadingPrefix(line: string): string {
  return line.replace(/^#{1,6}\s+/, "").trim();
}

export function splitMarkdownSections(markdown: string): WeeklyPromptSection[] {
  const sections: WeeklyPromptSection[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (!currentTitle) return;
    sections.push({
      title: currentTitle,
      content: currentLines.join("\n").trim(),
    });
    currentLines = [];
  }

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^##\s+/.test(line) && !/^###\s+/.test(line)) {
      flush();
      currentTitle = stripHeadingPrefix(line);
      continue;
    }
    if (currentTitle) currentLines.push(line);
  }

  flush();
  return sections;
}

export function splitMarkdownSubsections(markdown: string): WeeklyPromptSubsection[] {
  const subsections: WeeklyPromptSubsection[] = [];
  let currentTitle: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (!currentTitle) return;
    subsections.push({
      title: currentTitle,
      content: currentLines.join("\n").trim(),
    });
    currentLines = [];
  }

  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    if (/^###\s+/.test(line)) {
      flush();
      currentTitle = stripHeadingPrefix(line);
      continue;
    }
    if (currentTitle) currentLines.push(line);
  }

  flush();
  return subsections;
}

export function normalizeLarkMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      if (/^#{3,6}\s+/.test(line)) {
        return `**${stripHeadingPrefix(line)}**`;
      }
      return line;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function visibleSummary(input: WeeklyPromptCardInput): string {
  return [
    `**范围**：${input.totalPrs} 个 PR · ${input.projectCount} 个项目`,
    "_详细内容已折叠，请按章节展开查看。_",
  ].join("\n");
}

function formatActionPanelTitle(title: string): LarkText {
  return {
    tag: "lark_md",
    content: `<font color='red'>**${title}**</font>`,
  };
}

function buildCollapsedPanel(title: LarkText, content: string): LarkElement {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: { title },
    elements: [
      {
        tag: "markdown",
        content: normalizeLarkMarkdown(content || "_本节暂无内容。_"),
      },
    ],
  };
}

export function buildWeeklyPromptCard(input: WeeklyPromptCardInput): LarkCard {
  const elements: LarkElement[] = [
    {
      tag: "markdown",
      content: visibleSummary(input),
    },
    { tag: "hr" },
  ];

  const sections = splitMarkdownSections(input.markdown);
  const renderSections =
    sections.length > 0
      ? sections
      : [{ title: "周报全文", content: input.markdown.trim() || "_本周报没有生成正文。_" }];
  for (const section of renderSections) {
    if (ACTION_SECTION_TITLES.has(section.title)) {
      const actionItems = splitMarkdownSubsections(section.content);
      if (actionItems.length > 0) {
        elements.push({ tag: "markdown", content: `**${section.title}**` });
        for (const item of actionItems) {
          elements.push(buildCollapsedPanel(formatActionPanelTitle(item.title), item.content));
        }
        continue;
      }
    }

    elements.push(buildCollapsedPanel({ tag: "plain_text", content: section.title }, section.content));
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Counterpart 周报 · ${input.dateRange}`,
      },
      template: "purple",
    },
    elements,
  };
}
