import { describe, expect, it } from "bun:test";
import type { LarkCollapsiblePanel, LarkMarkdownElement } from "./daily-card";
import {
  buildWeeklyPromptCard,
  normalizeLarkMarkdown,
  splitMarkdownSections,
  splitMarkdownSubsections,
} from "./weekly-prompt-card";

describe("weekly prompt Lark card", () => {
  const markdown = `# Weekly Engineering Intelligence

## 优先跟进事项

### 1. 检查 prover-service worker session 收敛
为什么重要：worker 领取和重试语义本周变化集中。
需要检查：确认 Mantle 侧是否依赖旧的请求路径。
证据：base/base#3267, base/base#3246

### 2. 跟进 interop failsafe 指标
为什么重要：failsafe 观测能力直接影响事故定位。
需要检查：确认监控面板是否覆盖新指标。

## 风险信号

- op-challenger 超时清理 VM 进程组，说明故障恢复路径仍在补强。

## 证据索引

- base/base#3267
- optimism#21268
`;

  it("splits markdown into top-level weekly sections", () => {
    const sections = splitMarkdownSections(markdown);

    expect(sections.map((s) => s.title)).toEqual([
      "优先跟进事项",
      "风险信号",
      "证据索引",
    ]);
    expect(sections[0]!.content).toContain("### 1. 检查 prover-service worker session 收敛");
  });

  it("splits Action Items into subsection panels", () => {
    const actionSection = splitMarkdownSections(markdown)[0]!;
    const subsections = splitMarkdownSubsections(actionSection.content);

    expect(subsections.map((s) => s.title)).toEqual([
      "1. 检查 prover-service worker session 收敛",
      "2. 跟进 interop failsafe 指标",
    ]);
    expect(subsections[0]!.content).toContain("为什么重要：worker 领取和重试语义本周变化集中。");
    expect(subsections[0]!.content).not.toContain("跟进 interop failsafe 指标");
    expect(subsections[1]!.content).toContain("确认监控面板是否覆盖新指标");
  });

  it("builds a Chinese card with one range summary and collapsed action panels", () => {
    const card = buildWeeklyPromptCard({
      dateRange: "6月1日-6月7日",
      markdown,
      totalPrs: 90,
      projectCount: 5,
    });

    expect(card.header.title.content).toBe("Counterpart 周报 · 6月1日-6月7日");
    expect(card.header.template).toBe("purple");

    const visibleMarkdown = card.elements.find((el) => el.tag === "markdown") as LarkMarkdownElement;
    expect(visibleMarkdown.content).toContain("**范围**：90 个 PR · 5 个项目");
    expect(visibleMarkdown.content).not.toContain("**优先跟进**");
    expect(visibleMarkdown.content).not.toContain("1. 检查 prover-service worker session 收敛");
    expect(visibleMarkdown.content).not.toContain("2. 跟进 interop failsafe 指标");
    expect(visibleMarkdown.content).not.toContain("为什么重要");
    expect(visibleMarkdown.content).not.toContain("\n- 1.");
    expect(visibleMarkdown.content).not.toContain("\n- a.");

    const sectionLabels = card.elements.filter(
      (el): el is LarkMarkdownElement => el.tag === "markdown" && el.content === "**优先跟进事项**"
    );
    expect(sectionLabels).toHaveLength(1);

    const panels = card.elements.filter((el): el is LarkCollapsiblePanel => el.tag === "collapsible_panel");
    expect(panels).toHaveLength(4);
    expect(panels.every((panel) => panel.expanded === false)).toBe(true);
    expect(panels[0]!.header.title).toEqual({
      tag: "lark_md",
      content: "<font color='red'>**1. 检查 prover-service worker session 收敛**</font>",
    });
    expect(panels[1]!.header.title).toEqual({
      tag: "lark_md",
      content: "<font color='red'>**2. 跟进 interop failsafe 指标**</font>",
    });
    expect(panels[2]!.header.title).toEqual({ tag: "plain_text", content: "风险信号" });
    expect(panels[3]!.header.title).toEqual({ tag: "plain_text", content: "证据索引" });
    expect(JSON.stringify(panels)).toContain("为什么重要");
    expect(panels[0]!.elements[0]!.content).toContain("为什么重要：worker 领取和重试语义本周变化集中。");
    expect(panels[0]!.elements[0]!.content).not.toContain("跟进 interop failsafe 指标");
    expect(panels[1]!.elements[0]!.content).toContain("确认监控面板是否覆盖新指标");
    expect(panels[0]!.elements[0]!.content).not.toContain("###");
  });

  it("normalizes subsection headings for Lark markdown", () => {
    const content = normalizeLarkMarkdown(`### a. Base L3/Appchain 基础设施
为什么重要：示例。

#### 检查要点
- 子项`);

    expect(content).toContain("**a. Base L3/Appchain 基础设施**");
    expect(content).toContain("**检查要点**");
    expect(content).not.toContain("###");
    expect(content).not.toContain("####");
  });

  it("falls back to one collapsed full-text panel when markdown has no sections", () => {
    const card = buildWeeklyPromptCard({
      dateRange: "6月1日-6月7日",
      markdown: "本周没有按章节输出，但仍然需要投递。",
      totalPrs: 1,
      projectCount: 1,
    });

    const panels = card.elements.filter((el): el is LarkCollapsiblePanel => el.tag === "collapsible_panel");
    expect(panels).toHaveLength(1);
    expect(panels[0]!.expanded).toBe(false);
    expect(panels[0]!.header.title.content).toBe("周报全文");
    expect(panels[0]!.elements[0]!.content).toContain("本周没有按章节输出");
  });
});
