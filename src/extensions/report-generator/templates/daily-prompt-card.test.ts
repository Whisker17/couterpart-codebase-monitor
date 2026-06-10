import { describe, expect, it } from "bun:test";
import type { LarkCollapsiblePanel, LarkElement, LarkTableElement } from "./lark-card";
import { buildDailyPromptCard } from "./daily-prompt-card";

function panels(elements: LarkElement[]): LarkCollapsiblePanel[] {
  return elements.filter((el): el is LarkCollapsiblePanel => el.tag === "collapsible_panel");
}

function tables(elements: LarkElement[]): LarkTableElement[] {
  return elements.filter((el): el is LarkTableElement => el.tag === "table");
}

describe("daily prompt Lark card", () => {
  it("keeps overview and red PR analysis visible while rendering all PRs as folded repo lists", () => {
    const markdown = `
## 总览
昨天共合并 **7 个 PR**，覆盖 **2 个项目**。
- **指标：** 🔴 方向性变更；**数量：** 1
- **指标：** 🟡 重要 PR；**数量：** 4
- **指标：** ⚪ 日常维护；**数量：** 2

### base
base/base 主要集中在 prover API 和文档维护。

## 重点 PR 解读
### 1. [#3285 Move prover API](https://github.com/base/base/pull/3285)
**变更**：Base prover API 开始收敛 worker pull 模型。
**为什么重要**：这会影响后续 proposer 与 worker 的职责边界。
**工程判断**：这会影响后续 proposer 与 worker 的职责边界。

### 2. 🟡 [#3281 Fix docs](https://github.com/base/base/pull/3281)
**变更**：修正文档。
**为什么重要**：低风险维护。

## 全部 PR
### base/base
| 重要性 | PR | 一句话总结 |
| --- | --- | --- |
| 🔴 | [#3285 Move prover API](https://github.com/base/base/pull/3285) | 将 prover API 切向 worker pull。 |
| ⚪ | [#3281 Fix docs](https://github.com/base/base/pull/3281) | 修正文档中的参数描述。 |

### ethereum-optimism/optimism
| 重要性 | PR | 一句话总结 |
| --- | --- | --- |
| 🟡 | [#21034 Add SDM tests](https://github.com/ethereum-optimism/optimism/pull/21034) | 为 SDM 增加验收测试。 |
`.trim();

    const card = buildDailyPromptCard({
      date: "2026-06-07",
      markdown,
      totalPrs: 7,
      projectCount: 2,
      directionalShiftCount: 1,
      notableCount: 4,
      routineCount: 2,
      projects: [
        {
          projectId: "base/base",
          prCount: 2,
          directionalShiftCount: 1,
          notableCount: 0,
          routineCount: 1,
          prs: [
            {
              prNumber: 3285,
              title: "Move prover API",
              htmlUrl: "https://github.com/base/base/pull/3285",
              summary: "Raw fallback summary",
              significance: "directional_shift",
            },
            {
              prNumber: 3281,
              title: "Fix docs",
              htmlUrl: "https://github.com/base/base/pull/3281",
              summary: "Raw docs fallback",
              significance: "routine",
            },
          ],
        },
        {
          projectId: "ethereum-optimism/optimism",
          prCount: 1,
          directionalShiftCount: 0,
          notableCount: 1,
          routineCount: 0,
          prs: [
            {
              prNumber: 21034,
              title: "Add SDM tests",
              htmlUrl: "https://github.com/ethereum-optimism/optimism/pull/21034",
              summary: "Raw SDM fallback",
              significance: "notable",
            },
          ],
        },
      ],
    });

    expect(card.header.title.content).toBe("Counterpart 日报 · 2026-06-07");
    expect(card.header.template).toBe("orange");

    const visibleMarkdown = card.elements
      .filter((el) => el.tag === "markdown")
      .map((el) => el.content)
      .join("\n\n");
    expect(visibleMarkdown).toContain("**总览**");
    expect(visibleMarkdown).not.toContain("昨天共合并 **7 个 PR**");
    expect(visibleMarkdown).not.toContain("**指标：**");
    expect(visibleMarkdown).toContain("**base**");
    expect(visibleMarkdown).toContain("base/base 主要集中在 prover API 和文档维护。");
    expect(visibleMarkdown).toContain("**重点 PR 解读**");
    expect(visibleMarkdown).toContain("<font color='red'>**1. [#3285 Move prover API]");
    expect(visibleMarkdown).not.toContain("工程判断");
    expect(visibleMarkdown).not.toContain("#3281 Fix docs");
    expect(visibleMarkdown).toContain("**全部 PR**");
    expect(visibleMarkdown).not.toContain("| 重要性 |");
    expect(visibleMarkdown).not.toContain("将 prover API 切向 worker pull");

    expect(tables(card.elements)).toHaveLength(0);
    const collapsedPanels = panels(card.elements);
    expect(collapsedPanels).toHaveLength(2);
    expect(collapsedPanels[0]!.header.title.content).toBe("base/base");
    expect(collapsedPanels[0]!.expanded).toBe(false);
    expect(collapsedPanels[0]!.elements[0]!.content).toContain(
      "- 🔴 [#3285 Move prover API](https://github.com/base/base/pull/3285)：将 prover API 切向 worker pull。"
    );
    expect(collapsedPanels[0]!.elements[0]!.content).toContain(
      "- ⚪ [#3281 Fix docs](https://github.com/base/base/pull/3281)：修正文档中的参数描述。"
    );
  });

  it("fills empty overview organization sections from structured project data", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-02",
      markdown: `
## 总览
### base

### optimism

### bnb-chain

## 全部 PR
`.trim(),
      totalPrs: 4,
      projectCount: 3,
      directionalShiftCount: 1,
      notableCount: 1,
      routineCount: 2,
      projects: [
        {
          projectId: "base/base",
          prCount: 2,
          directionalShiftCount: 1,
          notableCount: 1,
          routineCount: 0,
          prs: [
            {
              prNumber: 3145,
              title: "remove Default B20 variant",
              htmlUrl: "https://github.com/base/base/pull/3145",
              summary: "删除 Default B20 变体。",
              significance: "directional_shift",
            },
            {
              prNumber: 3050,
              title: "add B20 workload",
              htmlUrl: "https://github.com/base/base/pull/3050",
              summary: "新增 B20 工作负载。",
              significance: "notable",
            },
          ],
        },
        {
          projectId: "ethereum-optimism/optimism",
          prCount: 1,
          directionalShiftCount: 0,
          notableCount: 0,
          routineCount: 1,
          prs: [
            {
              prNumber: 21034,
              title: "docs update",
              htmlUrl: "https://github.com/ethereum-optimism/optimism/pull/21034",
              summary: "更新文档。",
              significance: "routine",
            },
          ],
        },
        {
          projectId: "bnb-chain/bsc",
          prCount: 1,
          directionalShiftCount: 0,
          notableCount: 0,
          routineCount: 1,
          prs: [
            {
              prNumber: 801,
              title: "cherry-pick getProof limit",
              htmlUrl: "https://github.com/bnb-chain/bsc/pull/801",
              summary: "限制 getProof 存储键数量。",
              significance: "routine",
            },
          ],
        },
      ],
    });

    const visibleMarkdown = card.elements
      .filter((el) => el.tag === "markdown")
      .map((el) => el.content)
      .join("\n");
    expect(visibleMarkdown).toContain("**总览**");
    expect(visibleMarkdown).toContain("**base**");
    expect(visibleMarkdown).toContain("base/base：2 个 PR");
    expect(visibleMarkdown).toContain("主线是删除 Default B20 变体");
    expect(visibleMarkdown).toContain("**optimism**");
    expect(visibleMarkdown).toContain("ethereum-optimism/optimism：1 个 PR");
    expect(visibleMarkdown).toContain("**bnb-chain**");
    expect(visibleMarkdown).toContain("bnb-chain/bsc：1 个 PR");
  });

  it("summarizes empty overview repo sections with PR summaries instead of only PR titles", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-02",
      markdown: `
## 总览
### base

## 全部 PR
### base/base
- 🔴 [#3145 remove Default B20 variant](https://github.com/base/base/pull/3145)：删除通用 Default 变体，仅保留 Stablecoin 和 Asset，共享类型抽至 common 模块。
- 🟡 [#3050 add B20 workload](https://github.com/base/base/pull/3050)：为 load test 框架新增 B20 预编译代币工作负载。
- 🟡 [#3165 Align B20 Base Std Interface](https://github.com/base/base/pull/3165)：移除 redemption 路径并对齐 base-std 接口。
`.trim(),
      totalPrs: 3,
      projectCount: 1,
      directionalShiftCount: 1,
      notableCount: 2,
      routineCount: 0,
      projects: [
        {
          projectId: "base/base",
          prCount: 3,
          directionalShiftCount: 1,
          notableCount: 2,
          routineCount: 0,
          prs: [
            {
              prNumber: 3145,
              title: "remove Default B20 variant",
              htmlUrl: "https://github.com/base/base/pull/3145",
              summary: "Remove the Default B20 token variant.",
              significance: "directional_shift",
            },
            {
              prNumber: 3050,
              title: "add B20 workload",
              htmlUrl: "https://github.com/base/base/pull/3050",
              summary: "Add B20 precompile workload.",
              significance: "notable",
            },
            {
              prNumber: 3165,
              title: "Align B20 Base Std Interface",
              htmlUrl: "https://github.com/base/base/pull/3165",
              summary: "Align B20 interface with base-std.",
              significance: "notable",
            },
          ],
        },
      ],
    });

    const visibleMarkdown = card.elements
      .filter((el) => el.tag === "markdown")
      .map((el) => el.content)
      .join("\n");

    expect(visibleMarkdown).toContain("base/base：3 个 PR");
    expect(visibleMarkdown).toContain("主线是删除通用 Default 变体");
    expect(visibleMarkdown).toContain("同时推进为 load test 框架新增 B20 预编译代币工作负载");
    expect(visibleMarkdown).not.toContain("重点包括 #3145 remove Default B20 variant");
  });

  it("removes generated markdown dividers so the card owns section spacing", () => {
    const markdown = `
## 总览
昨日 PR 活动较稳定。

---

## 重点 PR 解读
暂无方向性变化。

---

## 全部 PR
### base/base
| 重要性 | PR | 一句话总结 |
| --- | --- | --- |
| ⚪ | [#1 Fix docs](https://github.com/base/base/pull/1) | 修正文档。 |
`.trim();

    const card = buildDailyPromptCard({
      date: "2026-06-07",
      markdown,
      totalPrs: 1,
      projectCount: 1,
      directionalShiftCount: 0,
      notableCount: 0,
      routineCount: 1,
    });

    const visibleMarkdown = card.elements
      .filter((el) => el.tag === "markdown")
      .map((el) => el.content)
      .join("\n");
    expect(visibleMarkdown).not.toContain("---");
  });

  it("does not emit adjacent divider elements before the folded PR section", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-07",
      markdown: `
## 总览
昨日 PR 活动较稳定。

## 重点 PR 解读
暂无方向性变化。

## 全部 PR
### base/base
| 重要性 | PR | 一句话总结 |
| --- | --- | --- |
| ⚪ | [#1 Fix docs](https://github.com/base/base/pull/1) | 修正文档。 |
`.trim(),
      totalPrs: 1,
      projectCount: 1,
      directionalShiftCount: 0,
      notableCount: 0,
      routineCount: 1,
    });

    for (let i = 1; i < card.elements.length; i++) {
      expect(card.elements[i - 1]!.tag === "hr" && card.elements[i]!.tag === "hr").toBe(false);
    }
  });

  it("uses structured PR input to avoid truncated markdown output on large days", () => {
    const prs = Array.from({ length: 52 }, (_, i) => ({
      prNumber: 3100 + i,
      title: `PR ${i}`,
      htmlUrl: `https://github.com/base/base/pull/${3100 + i}`,
      summary: `Fallback summary ${i}`,
      significance:
        i < 2 ? ("directional_shift" as const) : i < 22 ? ("notable" as const) : ("routine" as const),
    }));
    const markdown = `
## 总览
### base
base/base 当日 PR 较多。

## 重点 PR 解读
### 1. 🔴 [#3100 PR 0](https://github.com/base/base/pull/3100)
**变更**：方向变化。
**为什么重要**：影响架构。

## 全部 PR
### base/base
| 重要性 | PR | 一句话总结 |
| --- | --- | --- |
| 🔴 | [#3100 PR 0](https://github.com/base/base/pull/3100) | 中文摘要 0。 |
| ⚪ | [#3151 PR 51](https://github.com/base/base/pull/3151) | 中文摘要 51。
`.trim();

    const card = buildDailyPromptCard({
      date: "2026-06-02",
      markdown,
      totalPrs: 52,
      projectCount: 1,
      directionalShiftCount: 2,
      notableCount: 20,
      routineCount: 30,
      projects: [
        {
          projectId: "base/base",
          prCount: 52,
          directionalShiftCount: 2,
          notableCount: 20,
          routineCount: 30,
          prs,
        },
      ],
    });

    expect(tables(card.elements)).toHaveLength(0);
    const collapsedPanels = panels(card.elements);
    expect(collapsedPanels).toHaveLength(1);
    expect(collapsedPanels[0]!.header.title.content).toBe("base/base");
    const listContent = collapsedPanels[0]!.elements[0]!.content;
    expect(listContent.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(52);
    expect(listContent).toContain(
      "- 🔴 [#3100 PR 0](https://github.com/base/base/pull/3100)：中文摘要 0。"
    );
    expect(listContent).toContain(
      "- ⚪ [#3151 PR 51](https://github.com/base/base/pull/3151)：Fallback summary 51"
    );
    const cardJson = JSON.stringify(card);
    expect(cardJson).not.toContain("| ⚪ | [#3151 PR 51]");
  });

  it("adds structured folded all-PR lists even when the generated markdown omits the section", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-02",
      markdown: "## 总览\n### base\nbase/base 当日 PR 较多。",
      totalPrs: 1,
      projectCount: 1,
      directionalShiftCount: 0,
      notableCount: 1,
      routineCount: 0,
      projects: [
        {
          projectId: "base/base",
          prCount: 1,
          directionalShiftCount: 0,
          notableCount: 1,
          routineCount: 0,
          prs: [
            {
              prNumber: 3050,
              title: "feat(load tests): add B20 workload",
              htmlUrl: "https://github.com/base/base/pull/3050",
              summary: "为负载测试框架新增 B20 预编译代币工作负载。",
              significance: "notable",
            },
          ],
        },
      ],
    });

    const visibleMarkdown = card.elements
      .filter((el) => el.tag === "markdown")
      .map((el) => el.content)
      .join("\n");
    expect(visibleMarkdown).toContain("**全部 PR**");
    expect(tables(card.elements)).toHaveLength(0);
    const collapsedPanels = panels(card.elements);
    expect(collapsedPanels).toHaveLength(1);
    expect(collapsedPanels[0]!.header.title.content).toBe("base/base");
    expect(collapsedPanels[0]!.elements[0]!.content).toContain(
      "- 🟡 [#3050 feat(load tests): add B20 workload](https://github.com/base/base/pull/3050)：为负载测试框架新增 B20 预编译代币工作负载。"
    );
  });

  it("does not use Lark table elements for the structured all-PR list", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-02",
      markdown: "## 总览\n### base\nbase/base 当日 PR 较多。",
      totalPrs: 1,
      projectCount: 1,
      directionalShiftCount: 0,
      notableCount: 1,
      routineCount: 0,
      projects: [
        {
          projectId: "base/base",
          prCount: 1,
          directionalShiftCount: 0,
          notableCount: 1,
          routineCount: 0,
          prs: [
            {
              prNumber: 3050,
              title: "feat(load tests): add B20 workload",
              htmlUrl: "https://github.com/base/base/pull/3050",
              summary: "为负载测试框架新增 B20 预编译代币工作负载。",
              significance: "notable",
            },
          ],
        },
      ],
    });

    expect(tables(card.elements)).toHaveLength(0);
    expect(JSON.stringify(card)).not.toContain("\"tag\":\"table\"");
  });

  it("falls back to structured red PR summaries when focused analysis is omitted", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-02",
      markdown: "## 总览\n### base\nbase/base 当日 PR 较多。",
      totalPrs: 1,
      projectCount: 1,
      directionalShiftCount: 1,
      notableCount: 0,
      routineCount: 0,
      projects: [
        {
          projectId: "base/base",
          prCount: 1,
          directionalShiftCount: 1,
          notableCount: 0,
          routineCount: 0,
          prs: [
            {
              prNumber: 3145,
              title: "refactor(precompiles): remove Default B20 variant",
              htmlUrl: "https://github.com/base/base/pull/3145",
              summary: "移除通用 Default B20 变体，仅保留 Stablecoin 和 Asset。",
              significance: "directional_shift",
            },
          ],
        },
      ],
    });

    const visibleMarkdown = card.elements
      .filter((el) => el.tag === "markdown")
      .map((el) => el.content)
      .join("\n");
    expect(visibleMarkdown).toContain("**重点 PR 解读**");
    expect(visibleMarkdown).toContain("<font color='red'>**base/base #3145");
    expect(visibleMarkdown).toContain("移除通用 Default B20 变体");
  });

  it("falls back to a single folded full text panel when expected sections are absent", () => {
    const card = buildDailyPromptCard({
      date: "2026-06-07",
      markdown: "# Daily output\nPlain generated content",
      totalPrs: 1,
      projectCount: 1,
      directionalShiftCount: 1,
      notableCount: 0,
      routineCount: 0,
    });

    expect(card.header.template).toBe("orange");
    const collapsedPanels = panels(card.elements);
    expect(collapsedPanels).toHaveLength(1);
    expect(collapsedPanels[0]!.header.title.content).toBe("日报全文");
    expect(collapsedPanels[0]!.elements[0]!.content).toContain("**Daily output**");
    expect(collapsedPanels[0]!.elements[0]!.content).not.toContain("# Daily output");
  });
});
