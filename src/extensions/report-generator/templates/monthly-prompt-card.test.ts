import { describe, expect, it } from "bun:test";
import type { LarkCollapsiblePanel, LarkMarkdownElement } from "./lark-card";
import { buildMonthlyPromptCard } from "./monthly-prompt-card";

describe("monthly prompt Lark card", () => {
  const markdown = `# Counterpart 月报 · 2026年6月

> 本报告为月初至今观察。

## 月度判断

1. **Base 正在从 L2 向结算层角色跃迁。**
2. **证明系统正在经历架构世代交替。**

---

## 核心叙事

### 叙事一：Base 作为结算基础设施
- 事实基础：L3 devnet 基础设施已出现。
- 可能含义：值得继续观察。

## 项目轨迹

### Base
本月姿态：加速 + 多线并进。

## 跨项目趋势

| 趋势 | 说明 |
|-----|-----|
| Rust 化 | Optimism Rust 栈强化 |

## 下月观察

### 1. Base L3 devnet 是否实际出块
为什么看：L3 基础设施已铺设完毕。

### 2. 外部 Prover 协议是否公开
为什么看：worker API 可能形成标准。

## 证据索引

- Base L3：base/base#3217, base/base#3219
- Kona 迁移：optimism#21193
`;

  it("renders high-level monthly sections visible and folds next-month/evidence sections", () => {
    const card = buildMonthlyPromptCard({
      monthLabel: "2026年6月",
      periodLabel: "2026-06-01..2026-06-08 (month-to-date)",
      markdown,
      totalPrs: 216,
      projectCount: 5,
      isPartial: true,
    });

    expect(card.header.title.content).toBe("Counterpart 月报 · 2026年6月");
    expect(card.header.template).toBe("purple");

    const markdownElements = card.elements.filter(
      (el): el is LarkMarkdownElement => el.tag === "markdown"
    );
    const visibleContent = markdownElements.map((el) => el.content).join("\n");
    expect(visibleContent).toContain("**范围**：2026-06-01..2026-06-08 (month-to-date)");
    expect(visibleContent).toContain("**规模**：216 个 PR · 5 个项目");
    expect(visibleContent).toContain("_本月报为月初至今观察，尚非完整自然月。_");
    expect(visibleContent).toContain("**月度判断**");
    expect(visibleContent).toContain("Base 正在从 L2 向结算层角色跃迁");
    expect(visibleContent).toContain("**核心叙事**");
    expect(visibleContent).toContain("**项目轨迹**");
    expect(visibleContent).toContain("**跨项目趋势**");
    expect(visibleContent).toContain("- **趋势：** Rust 化；**说明：** Optimism Rust 栈强化");
    expect(visibleContent).not.toContain("Base L3 devnet 是否实际出块");
    expect(visibleContent).not.toContain("base/base#3217");
    expect(visibleContent).not.toContain("##");
    expect(visibleContent).not.toContain("###");
    expect(visibleContent).not.toContain("---");

    const panels = card.elements.filter(
      (el): el is LarkCollapsiblePanel => el.tag === "collapsible_panel"
    );
    expect(panels).toHaveLength(2);
    expect(panels.every((panel) => panel.expanded === false)).toBe(true);
    expect(panels[0]!.header.title.content).toBe("下月观察");
    expect(panels[0]!.elements[0]!.content).toContain("**1. Base L3 devnet 是否实际出块**");
    expect(panels[1]!.header.title.content).toBe("证据索引");
    expect(panels[1]!.elements[0]!.content).toContain("base/base#3217");
  });

  it("falls back to a folded full-text panel when no monthly sections are present", () => {
    const card = buildMonthlyPromptCard({
      monthLabel: "2026年6月",
      periodLabel: "2026-06-01..2026-06-08",
      markdown: "没有按章节生成的月报正文。",
      totalPrs: 1,
      projectCount: 1,
      isPartial: false,
    });

    const panels = card.elements.filter(
      (el): el is LarkCollapsiblePanel => el.tag === "collapsible_panel"
    );
    expect(panels).toHaveLength(1);
    expect(panels[0]!.header.title.content).toBe("月报全文");
    expect(panels[0]!.elements[0]!.content).toContain("没有按章节生成");
  });
});
