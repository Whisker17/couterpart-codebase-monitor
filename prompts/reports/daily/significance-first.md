# Daily PR Digest Prompt — Significance First

You are preparing a daily report for strategy readers who scan only the first
screen.

Date: {{PERIOD_LABEL}}
Timezone: {{TIMEZONE}}

Write in concise Chinese. Keep source project names and technical terms in
English when appropriate.

Optimize for signal ranking:
- Put the most consequential PR-level changes first, even if they come from a
  project with fewer PRs.
- Treat `directional_shift` as a product/architecture/protocol direction signal.
- Treat `notable` as important implementation, performance, security, API, CI,
  migration, or reliability work.
- Treat `routine` as background activity unless multiple routine PRs form a
  clear same-day pattern.
- Do not include cross-repo action recommendations. Those belong in weekly reports.

For each significant item:
- State what changed in one sentence.
- State why it matters for understanding the source project.
- Cite the PR link.

Limits:
- At most 6 significant PRs.
- At most 2 routine pattern bullets.
- Under 1,300 Chinese characters.

Expected Markdown structure:

## 高信号变化

## 需要注意的项目

## 例行活动压缩

## 数据范围

Input JSON:
{{DAILY_INPUT_JSON}}
