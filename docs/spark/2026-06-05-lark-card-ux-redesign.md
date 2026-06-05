# Lark Card UX Redesign

**Date:** 2026-06-05  
**Status:** Approved  
**Scope:** Daily card + weekly card visual overhaul — no pipeline or data model changes

---

## Background

The daily card's summary section does not clearly surface the day's actual engineering signal, and all project details are packed into a single collapsible panel, which becomes unwieldy as the number of tracked repos grows. Two user-requested improvements plus three additional UX enhancements were approved.

---

## Changes

### 1. Daily Card — Dynamic Header Color

The card header color reflects the highest significance level across all projects that day.

| Condition | Lark template color |
|-----------|---------------------|
| Any `directional_shift` PR | `orange` |
| Only `notable` PRs (no directional) | `yellow` |
| All `routine` PRs | `blue` |

Implementation: add `resolveHeaderTemplate(analyses: GroupedAnalyses): string` in `daily-card.ts`. Called inside `buildDailyCard()` before constructing the card object.

---

### 2. Daily Card — New Summary Format (C Style)

Replace the current bullet-list summary with a two-part structure:

**Part 1 — Metric pills (one line)**
```
[5 repos] [12 PR] [🔴 ×2] [🟡 ×3] [⚪ ×7]
```
Omit pill if count is zero (e.g. no directional shifts → omit `🔴 ×0`).

**Part 2 — Signal table**
One row per project, always listing all projects. Lark markdown uses proportional fonts so column alignment is not attempted; format is:
```
🔴 **reth** — async executor 架构迁移，下游兼容性风险
🔴 **lighthouse** — 新 consensus API 接口引入
🟡 **geth** — EIP-7702 支持新增
⚪ revm — 2 routine PR
⚪ alloy — 3 routine PR
```
- Notable/directional rows: `{emoji} **{projectId}** — {signal}` where signal = top direction signal, falling back to summary, truncated to 60 chars
- Routine rows: `{emoji} {projectId} — N routine PR` (no bold, visually de-emphasized)

Implementation: `buildSummaryContent(analyses: GroupedAnalyses): string` — pure function, replaces the existing summary construction block in `buildDailyCard()`.

---

### 3. Daily Card — Per-repo Collapsible Panels

Replace the single `collapsible_panel` with one panel per project that has at least one notable or directional PR. Routine-only projects do **not** get a panel.

**Panel header:** `{emoji} {projectId} · {N} PR`
- emoji = 🔴 if any directional_shift, 🟡 if only notable

**Default expanded:** repos with `directional_shift` or `notable` PRs → `expanded: true`

**Panel body content (unchanged from current logic):**
- Significant PRs (directional + notable) shown in full: link, badge, summary, direction signal
- Routine PRs within a notable repo: `_N routine PR not expanded_` note at the bottom
- Routine-only repos: omitted entirely (no panel)

**Edge cases:**
- If all projects are routine → no panels generated; append a single markdown element: `_All PRs are routine today._`
- `formatter.ts` Level 3 fallback (per-project split) calls `buildDailyCard(date, [singleProject], ...)` — works as-is; single project with no notable PRs produces no panels, which is the correct behavior

Implementation: `buildRepoPanels(analyses: GroupedAnalyses): LarkElement[]` — returns an array of `LarkCollapsiblePanel` elements (or a single fallback markdown). Replaces the current single-panel block in `buildDailyCard()`.

---

### 4. Weekly Card — Per-repo Collapsible Panels

Replace the single `collapsible_panel` ("Per-project Highlights") with one panel per project.

- All panels default to **collapsed** (weekly has Direction Changes + Activity Summary always visible, which already surfaces the key signals)
- Panel header: `{projectId} · {N} PR`
- Panel body: same as current (PR list with badge + summary + direction signal)
- Weekly header color: **unchanged** (`purple`) — distinct from daily cadence

Implementation: refactor `buildWeeklyCard()` in `weekly-card.ts` to iterate `data.projectHighlights` and emit one `collapsible_panel` per project instead of one combined panel.

---

## File Impact

| File | Change |
|------|--------|
| `src/extensions/report-generator/templates/daily-card.ts` | `resolveHeaderTemplate()`, `buildSummaryContent()`, `buildRepoPanels()` — replaces summary + panel logic in `buildDailyCard()` |
| `src/extensions/report-generator/templates/weekly-card.ts` | Per-repo panels in `buildWeeklyCard()` |
| `src/extensions/report-generator/templates/daily-card.test.ts` | Update assertions for new summary format, panel structure, header color |
| `src/extensions/report-generator/templates/weekly-card.test.ts` | Update assertions for per-repo panels |
| `src/extensions/lark-dispatcher/formatter.test.ts` | Minor: card structure assertions if any reference the old single-panel shape |

No changes to: `formatter.ts` (size-based fallback still works), `delivery-localizer.ts`, pipeline stages, data model, or Lark webhook.

---

## Out of Scope

- Card interactivity (Lark cards are read-only)
- Changing what data is collected or analyzed
- Mobile vs desktop layout (Lark renders `wide_screen_mode: true` per existing config)
- Pagination or multi-card splitting logic (no change to `formatter.ts`)
