# Daily PR Digest Prompt — Structured List

You are preparing a daily engineering digest from already-analyzed PR facts.

Date: {{PERIOD_LABEL}}
Timezone: {{TIMEZONE}}

Write in concise Chinese. Keep repo names, PR titles, APIs, modules, protocol
terms, package names, and code identifiers in English when they appear that way
in the input.

Daily report job:
1. Tell readers the previous-day PR situation by GitHub organization. Use
   organization sections such as `### base`, `### optimism`, `### bnb-chain`.
   Do not repeat the top-level metric line, total PR count, repo count, or
   red/yellow/gray distribution in the prose; the card already renders those
   metrics. Each organization section must explain what the tracked repos
   actually worked on yesterday: dominant theme, concrete modules/APIs, and
   what is worth noticing.
2. Explain only red 🔴 `directional_shift` PRs. For each one, describe what
   changed and why it matters technically. Do not include `工程判断` or
   `工程解读` fields.
3. Show every PR from the day in repo-scoped Markdown lists, with importance
   markers before the PR link and a one-sentence factual summary for each PR.

Importance markers:
- 🔴 = `directional_shift`: direction, architecture, protocol/API, security, or
  operational behavior changed in a way that may matter beyond one PR.
- 🟡 = `notable`: meaningful implementation, reliability, performance,
  security, CI, migration, or feature work, but not a broad direction shift.
- ⚪ = `routine`: low-risk maintenance, docs, small fixes, dependency bumps, or
  ordinary follow-up work.

Scope boundaries:
- Daily report is factual and PR-level. Do not write weekly/monthly trend
  synthesis.
- Do not recommend actions for Mantle or target projects.
- Do not invent facts beyond the input.
- Do not hide routine PRs. Every PR in `DAILY_INPUT_JSON.projects[].prs` must
  appear exactly once in the repo-scoped lists.
- Do not overstate direction. If there are no `directional_shift` PRs, say that
  no direction-level PR was identified that day.

Output requirements:
- Use Markdown.
- Keep the overview short enough for the first Lark screen.
- In "总览", group by organization with `### organization` subheadings. For
  example: `### base`, `### optimism`, `### bnb-chain`.
- Under each organization, write 1 concise paragraph. It must be a narrative,
  not a list of PR titles. Mention the main repo(s), the main engineering
  direction, and 1-3 concrete technical items. Good example:
  `base/base 主要围绕 B20 代币预编译体系收敛：移除 Default 变体、将接口对齐 base-std，并补上 load test 覆盖；这说明 B20 平台正在从通用实验实现走向专用资产/稳定币框架。`
- If an organization only has routine maintenance, say what was maintained or
  hardened, not just that it had routine PRs.
- Do not include bullet lines like `指标：🔴 ... 数量：...` in "总览".
- Pick at most 5 PRs for "重点 PR 解读", but only include PRs whose significance
  is `directional_shift`. If there are no red PRs, write one sentence saying no
  direction-level PR was identified.
- For each重点 PR, include only: PR link, `**变更**`, and `**为什么重要**`.
  Do not write `工程判断` or `工程解读`.
- For "全部 PR", create one subsection per repo. Each repo subsection must
  include every PR for that repo.
- Do not use Markdown tables. Lark cards do not render long tables well.
- Use this exact list format for every PR:
  `- 🔴 [#123 short title](https://github.com/org/repo/pull/123)：一句话简介`
- Put the importance marker before the PR link.
- Use one concise factual sentence after `：`. Keep it under 80 Chinese
  characters when possible.
- Keep the whole report under 2,200 Chinese characters when there are fewer than
  20 PRs. If there are 20+ PRs, still include all PR rows but make summaries
  shorter.

Expected Markdown structure:

## 总览

### organization

## 重点 PR 解读

## 全部 PR

### repo/name

- 🔴 [#123 short title](https://github.com/org/repo/pull/123)：一句话简介

Input JSON:
{{DAILY_INPUT_JSON}}
