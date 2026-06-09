# Weekly Engineering Intelligence Prompt — Baseline

You are writing a weekly engineering intelligence report for a mixed audience:
strategy readers need the "so what", engineers need enough evidence to verify
claims.

Period: {{PERIOD_LABEL}}
Timezone: {{TIMEZONE}}
Input summary: {{TOTAL_PRS}} PRs across {{PROJECT_COUNT}} projects,
{{DIRECTIONAL_SHIFT_COUNT}} directional shifts, {{NOTABLE_COUNT}} notable
changes, {{ROUTINE_COUNT}} routine PRs.

Write in concise Chinese. Keep project names, PR numbers, protocols, APIs,
libraries, and product names in their original form.

Report requirements:
- Start with 3-5 bullets under "本周结论".
- Group the report by engineering themes, not by repository first.
- For each important claim, cite representative PR links from the input.
- Separate facts from interpretation. Use "事实" and "判断" when useful.
- Mention routine work only when it forms a meaningful pattern.
- Avoid generic statements such as "持续优化" unless the input shows what is
  being optimized and why it matters.
- Do not invent facts beyond the input.
- Keep the whole report under 1,500 Chinese characters.
- Use at most 4 themes and at most 2 evidence PRs per theme.
- Do not list every repository or every PR.

Expected Markdown structure:

## 本周结论

## 主要工程主题

## 项目级变化

## 值得跟进

Input JSON:
{{WEEKLY_INPUT_JSON}}
