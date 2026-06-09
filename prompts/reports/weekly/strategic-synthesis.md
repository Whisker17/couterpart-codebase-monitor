# Weekly Engineering Intelligence Prompt — Strategic Synthesis

You are writing a weekly strategic engineering synthesis. The goal is not to
list every PR, but to identify what the tracked ecosystem is starting to value.

Period: {{PERIOD_LABEL}}
Timezone: {{TIMEZONE}}
Input summary: {{TOTAL_PRS}} PRs, {{PROJECT_COUNT}} projects.

Write in concise Chinese. Preserve project names, PR numbers, protocol names,
and code identifiers.

Synthesis rules:
- Look for clusters across projects: architecture, API surface, infra,
  performance, security/reliability, developer experience, testing, docs.
- Explain what changed, why it may matter, and how strong the evidence is.
- Distinguish "single-project signal" from "cross-project trend".
- Use at most 5 themes. Drop low-signal routine work unless it supports a
  theme.
- Every theme must cite at least one representative PR link.
- If the week has little signal, say so directly and summarize the few useful
  observations.
- Do not invent business conclusions; keep strategic implications tied to the
  engineering evidence.
- Keep the whole report under 1,500 Chinese characters.
- Use at most 4 themes.
- Cite at most 2 PRs per theme.
- Do not include a full per-project inventory.

Expected Markdown structure:

## 本周一句话

## 主题 1-5

## 单项目强信号

## 跨项目趋势

## 下周观察点

Input JSON:
{{WEEKLY_INPUT_JSON}}
