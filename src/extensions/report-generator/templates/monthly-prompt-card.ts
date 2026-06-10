import type { LarkCard, LarkElement, LarkText } from "./lark-card";
import { normalizeLarkMarkdown, splitMarkdownSections } from "./weekly-prompt-card";

export interface MonthlyPromptCardInput {
  monthLabel: string;
  periodLabel: string;
  markdown: string;
  totalPrs: number;
  projectCount: number;
  isPartial: boolean;
}

const COLLAPSED_SECTION_TITLES = new Set(["下月观察", "证据索引"]);

function visibleSummary(input: MonthlyPromptCardInput): string {
  const lines = [
    `**范围**：${input.periodLabel}`,
    `**规模**：${input.totalPrs} 个 PR · ${input.projectCount} 个项目`,
  ];
  if (input.isPartial) {
    lines.push("_本月报为月初至今观察，尚非完整自然月。_");
  }
  return lines.join("\n");
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

function renderVisibleSection(title: string, content: string): LarkElement {
  return {
    tag: "markdown",
    content: normalizeLarkMarkdown(`## ${title}\n\n${content || "_本节暂无内容。_"}`),
  };
}

export function buildMonthlyPromptCard(input: MonthlyPromptCardInput): LarkCard {
  const elements: LarkElement[] = [
    {
      tag: "markdown",
      content: visibleSummary(input),
    },
    { tag: "hr" },
  ];

  const sections = splitMarkdownSections(input.markdown);
  if (sections.length === 0) {
    elements.push(
      buildCollapsedPanel(
        { tag: "plain_text", content: "月报全文" },
        input.markdown.trim() || "_本月报没有生成正文。_"
      )
    );
  } else {
    for (const section of sections) {
      if (COLLAPSED_SECTION_TITLES.has(section.title)) {
        elements.push(buildCollapsedPanel({ tag: "plain_text", content: section.title }, section.content));
      } else {
        elements.push(renderVisibleSection(section.title, section.content));
      }
    }
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: `Counterpart 月报 · ${input.monthLabel}`,
      },
      template: "purple",
    },
    elements,
  };
}
