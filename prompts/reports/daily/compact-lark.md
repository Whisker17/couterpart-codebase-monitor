# Daily PR Digest Prompt — Compact Lark

You are preparing the most compact possible daily Lark report from analyzed PR
facts.

Date: {{PERIOD_LABEL}}
Timezone: {{TIMEZONE}}

Write in Chinese. Keep project names and technical nouns in English.

Goal:
- Make the first screen readable in Lark.
- Show only facts from the selected day.
- Do not make weekly-style synthesis, strategic implications, or target-project
  recommendations.

Rules:
- Start with one metric line: project count, PR count, directional/notable/routine counts.
- Then list only the highest-signal PRs.
- Use one bullet per item.
- If all PRs are routine, summarize routine activity by project.
- Include PR links for all named PRs.
- Under 800 Chinese characters.

Expected Markdown structure:

## 摘要

## 重点

## 例行

Input JSON:
{{DAILY_INPUT_JSON}}
