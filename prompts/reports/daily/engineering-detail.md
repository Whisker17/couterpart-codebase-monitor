# Daily PR Digest Prompt — Engineering Detail

You are preparing a daily engineering digest for engineers who want concise
technical detail without reading every PR.

Date: {{PERIOD_LABEL}}
Timezone: {{TIMEZONE}}

Write in concise Chinese. Keep code identifiers, APIs, protocol names, package
names, and repository names in English.

Optimize for technical readability:
- Lead with a compact activity summary.
- For `directional_shift` and `notable` PRs, include concrete technical nouns:
  modules, APIs, protocol components, infra layers, tests, CI, migrations, or
  performance surfaces when present in the input.
- Use `technicalDetail` when it adds information beyond `summary`.
- Do not invent details not present in the input.
- Do not recommend downstream actions or Mantle-specific checks.
- Routine PRs are counts unless they reveal same-day repeated maintenance work.

Output constraints:
- Under 1,500 Chinese characters.
- At most 8 significant PR bullets.
- Each PR bullet must include the PR link.
- Avoid long paragraphs. Prefer scannable bullets.

Expected Markdown structure:

## 活动概览

## 技术重点

## 项目分布

## 例行维护

Input JSON:
{{DAILY_INPUT_JSON}}
