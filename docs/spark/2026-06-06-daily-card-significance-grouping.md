# Daily Card — Significance-First Grouping with Nested Panels

**Date:** 2026-06-06  
**Status:** Draft (rev 3)  
**Scope:** Daily card layout restructure — reorganize from repo-first to project-max-significance grouping  
**Supersedes:** Partially updates the panel logic from `2026-06-05-lark-card-ux-redesign.md`

---

## Background

Two issues observed in production daily cards:

1. **Summary signal truncation** — the 60-char hard limit in `buildSummaryContent` cuts off LLM-generated direction signals mid-sentence, losing the conclusion
2. **Panels not collapsed** — directional panels default to `expanded: true`, forcing the reader to scroll past PR details to see other projects

Additionally, the current flat per-repo panel list does not visually distinguish significance tiers. The user must read each panel header emoji to understand which PRs are directional vs. notable.

---

## Grouping Model

**Project-max-significance grouping**: each project is assigned to exactly one tier based on its highest-significance PR. A project with both directional and notable PRs appears only in the DIRECTIONAL tier — its notable PRs are shown inside that tier's repo panel, not duplicated into the NOTABLE tier.

Tiers:
- **DIRECTIONAL** — projects containing at least one `directional_shift` PR
- **NOTABLE** — projects whose highest significance is `notable` (no directional PRs)
- **Routine** — projects with only `routine` PRs (no panel, summary signal table only)

---

## Changes

### 1. Byte-Aware Sentence-Boundary Signal Soft Cap (replaces 60-char hard truncation)

**Current** (`daily-card.ts:148`):
```typescript
let signal = strippedSignal.length > 60 ? `${strippedSignal.slice(0, 60)}…` : strippedSignal;
```

**Problem**: 60 chars is too aggressive — cuts conclusions mid-sentence. But removing truncation entirely is risky: `formatter.ts` Level 2 only filters routine PRs (not signal text), and Level 3 logs oversized cards as errors but sends them anyway. Long LLM signals could push cards past the 30KB Lark limit without any content-level safeguard.

**New**: Byte-aware soft cap with sentence-boundary detection. Uses bytes (not chars) to stay consistent with `formatter.ts` which uses `Buffer.byteLength` for all size checks.

```typescript
const SIGNAL_BYTE_CAP = 500;

function truncateAtSentenceBoundary(text: string, byteCap: number): string {
  if (Buffer.byteLength(text, "utf-8") <= byteCap) return text;
  // Find the char index where we exceed byteCap
  let charLimit = 0;
  let bytes = 0;
  for (const ch of text) {
    bytes += Buffer.byteLength(ch, "utf-8");
    if (bytes > byteCap) break;
    charLimit++;
  }
  // Find last sentence boundary within charLimit
  const slice = [...text].slice(0, charLimit).join("");
  const boundaries = ["。", ". ", "！", "! ", "？", "? "];
  let lastBoundary = -1;
  for (const b of boundaries) {
    const idx = slice.lastIndexOf(b);
    if (idx > lastBoundary) lastBoundary = idx;
  }
  if (lastBoundary > charLimit * 0.4) {
    return text.slice(0, lastBoundary + 1).trim();
  }
  // No good boundary — hard cut with ellipsis
  return slice.trim() + "…";
}
```

Rules:
- Default soft cap: **500 bytes** (~166 Chinese chars / ~500 English chars, enough for 1–2 sentences in either language)
- Walk the string char-by-char accumulating `Buffer.byteLength` to find the byte-safe cut point
- Within that range, truncate at the last sentence boundary (。 `. ` ！ `! ` ？ `? `)
- If no sentence boundary found in the first 40% of the range, fall back to hard cut + `…`
- `.trim()` before returning to clean up trailing whitespace from boundary detection
- `stripCounterpartRecommendations` still runs first to remove cross-repo noise before truncation

**Why 500 bytes, not unlimited**: A 10-repo card where every project uses the full 500-byte signal cap = 5KB of signal text alone. With nested panel JSON overhead (~200 bytes per nesting level per panel, ≈ 4KB for 10 repos × 2 levels), total ≈ 9KB — well within the 20KB Level 1 threshold. Going unlimited would rely entirely on `formatter.ts` degradation, which only filters routine PRs — not signal text.

---

### 2. Significance-First Nested Panels

Replace the current flat per-repo panel list with a two-tier nested structure.

**Outer panels** — one per significance tier present that day:
- `🔴 DIRECTIONAL · {N} repos · {D} directional · {R} other` — D = directional PR count, R = non-directional PRs in those repos
- `🟡 NOTABLE · {N} repos · {B} notable · {R} other` — B = notable PR count, R = routine PRs in those repos

If `R` is 0, omit the `· {R} other` segment entirely.

**Inner panels** (nested inside outer) — one per repo:
- `{projectId} · {S} significant · {R} routine` (no emoji — outer panel conveys significance)
- If `R` is 0, show as `{projectId} · {S} PR`

Routine-only repos do not get panels (unchanged from current behavior).

#### Expanded state logic

- **Highest-priority outer panel**: `expanded: true` — so the reader immediately sees which repos are affected at this significance level
- **Other outer panels**: `expanded: false`
- **All inner repo panels**: `expanded: false` — the reader drills down by clicking a repo they care about

Priority order: DIRECTIONAL > NOTABLE. So if a DIRECTIONAL panel exists, it is expanded and NOTABLE is collapsed. If only NOTABLE exists, it is expanded.

This is more controlled than the old design (which expanded all directional panels including inner PR details) and less opaque than all-collapsed (which hides everything behind two click layers).

#### Inner repo sort order

Within each outer panel, repos are sorted deterministically:
1. Significant PR count descending (directional count for DIRECTIONAL tier, notable count for NOTABLE tier)
2. Total PR count descending (tiebreaker)
3. `projectId` ascending (final tiebreaker, alphabetical)

This prevents snapshot test flaking and gives the reader a stable, predictable order.

#### Card layout

```
┌──────────────────────────────────────────────────────────┐
│  Counterpart Monitor · Daily Digest · 2026-06-06         │  header (orange/yellow/blue)
├──────────────────────────────────────────────────────────┤
│  5 repos · 12 PR · 🔴 ×2 · 🟡 ×3 · ⚪ ×7                │  metric line
│                                                          │
│  🔴 **reth** — async executor 架构迁移，下游兼容性风险       │  signal table
│  🔴 **lighthouse** — 新 consensus API 接口引入              │  (sentence-aware soft cap)
│  🟡 **geth** — EIP-7702 支持新增                            │
│  ⚪ revm — 2 routine PR                                   │
│  ⚪ alloy — 3 routine PR                                  │
│                                                          │
│  ──────────────────── hr ────────────────────             │
│                                                          │
│  ▼ 🔴 DIRECTIONAL · 2 repos · 3 directional  [expanded]  │  outer (highest tier → expanded)
│     ▶ reth · 2 directional · 1 routine       [collapsed] │  inner (always collapsed)
│        #1234 async executor migration — summary...       │
│        Direction: ...                                    │
│        #1235 breaking change — summary...                │
│        _1 routine PR not expanded_                       │
│     ▶ lighthouse · 1 directional             [collapsed] │
│        #5678 consensus API — summary...                  │
│                                                          │
│  ▶ 🟡 NOTABLE · 1 repo · 3 notable · 1 other [collapsed] │  outer (not highest → collapsed)
│     ▶ geth · 3 notable · 1 routine           [collapsed] │
│        #9012 EIP-7702 — summary...                       │
│        ...                                               │
│                                                          │
│  (optional: non-warning budget line)                     │
└──────────────────────────────────────────────────────────┘
```

#### Outer panel JSON structure

```typescript
{
  tag: "collapsible_panel",
  expanded: true, // highest tier only; others false
  header: {
    title: {
      tag: "plain_text",
      content: "🔴 DIRECTIONAL · 2 repos · 3 directional"
    }
  },
  elements: [
    // Inner repo panels (LarkCollapsiblePanel[])
  ]
}
```

#### Inner panel JSON structure

```typescript
{
  tag: "collapsible_panel",
  expanded: false,
  header: {
    title: {
      tag: "plain_text",
      content: "reth · 2 directional · 1 routine"
    }
  },
  elements: [
    { tag: "markdown", content: "PR details..." }
  ]
}
```

#### Inner panel body content (unchanged from current)

- Significant PRs (directional + notable): link, badge, summary, direction signal
- Routine PRs within a mixed repo: `_N routine PR(s) not expanded_`
- Format per PR:
  ```
  [#1234 Title](url)
  🔴 DIRECTIONAL — summary text
  Direction: direction signal text
  ```

---

### 3. Edge Cases

| Scenario | Behavior |
|----------|----------|
| All routine day | No outer panels. Single markdown: `_All PRs are routine today._` |
| Only directional, no notable | One outer panel (DIRECTIONAL, expanded) |
| Only notable, no directional | One outer panel (NOTABLE, expanded) |
| Single repo in a tier | Outer panel still wraps it (consistent structure) |
| Project has both directional + notable PRs | All PRs shown in DIRECTIONAL tier's repo panel. Not duplicated to NOTABLE. |
| `formatter.ts` Level 2 degradation | Routine-only projects filtered out before `buildDailyCard` — nested panels receive only notable/directional data, works as-is |
| `formatter.ts` Level 3 (per-project split) | `buildDailyCard(date, [singleProject], ...)` — single project produces at most one outer panel with one inner panel |
| Signal text > 500 bytes | Truncated at last sentence boundary before byte cap; hard cut + `…` if no boundary found in first 40% of range |

---

### 4. Unchanged

- **Header color logic**: orange (any directional) / yellow (notable only) / blue (all routine)
- **Summary metric line format**: `{N} repos · {M} PR · 🔴 ×{n} · 🟡 ×{n} · ⚪ ×{n}`
- **Summary signal table**: per-project rows sorted by significance, same format (now with sentence-aware soft cap instead of hard 60-char cut)
- **Budget line placement**: warning in summary, non-warning at card bottom
- **Partial warning**: `⚠ {partialWarning}` at top of summary
- **`formatter.ts` degradation thresholds**: 20KB / 28KB
- **`webhook.ts`**: no changes
- **`weekly-card.ts`**: no changes (still deferred)

---

## Implementation

### Function changes in `daily-card.ts`

**New: `truncateAtSentenceBoundary(text, byteCap)`** — pure function, byte-aware sentence-boundary soft cap with 40% minimum boundary position.

**`buildSummaryContent`** — replace hard truncation with `truncateAtSentenceBoundary(strippedSignal, 500)`.

**`buildRepoPanels` → rename to `buildSignificancePanels`** — full rewrite:
1. Partition `analyses` into `directionalProjects` (any directional PR) and `notableProjects` (notable but no directional) using project-max-significance grouping
2. If both empty → return `[{ tag: "markdown", content: "_All PRs are routine today._" }]`
3. Build tier list in priority order: `[DIRECTIONAL, NOTABLE]`, filtering to non-empty tiers
4. First tier in list gets `expanded: true`; remaining tiers get `expanded: false`
5. Within each tier, sort repos by: significant PR count desc → total PR count desc → `projectId` asc
6. Build inner `collapsible_panel` per repo with `expanded: false`
7. Outer panel header: `{emoji} {TIER_NAME} · {N} repos · {D} {tier_label} [· {R} other]`
8. Inner panel header: `{projectId} · {S} significant [· {R} routine]` (omit routine segment if 0; if no routine, show `{S} PR`)
9. Inner panel body: same PR detail rendering as current `buildRepoPanels`

**`buildDailyCard`** — update call from `buildRepoPanels` to `buildSignificancePanels`

### Type changes

`LarkCollapsiblePanel.elements` type needs to support nested panels:
```typescript
export interface LarkCollapsiblePanel {
  tag: "collapsible_panel";
  expanded: boolean;
  header: { title: LarkText };
  elements: (LarkMarkdownElement | LarkCollapsiblePanel)[];
}
```

---

## File Impact

| File | Change |
|------|--------|
| `daily-card.ts` | Add `truncateAtSentenceBoundary` (byte-aware), update `buildSummaryContent`, rename+rewrite `buildRepoPanels` → `buildSignificancePanels`, update `LarkCollapsiblePanel` type, update `buildDailyCard` call site |
| `daily-card.test.ts` | Update panel structure assertions for nested panels, update truncation-related tests, add byte-aware sentence-boundary tests (Chinese-heavy, English-heavy, mixed, no-boundary-found, under-cap-passthrough) |
| `formatter.test.ts` | Minor: update if any tests reference old flat panel shape |

No changes to: `formatter.ts`, `webhook.ts`, `weekly-card.ts`, `delivery-localizer.ts`, pipeline stages, data model.

---

## Lark Platform Constraints

- Nested `collapsible_panel` is supported up to 5 levels deep (we use 2 levels — well within limit)
- `form` component is not allowed inside `collapsible_panel` (not relevant here)
- Deep nesting may compress display space on mobile — 2 levels is acceptable per Lark docs
- Current project uses **card JSON 1.0** (`elements` top-level array), not JSON 2.0 (`schema/body`). The JSON 1.0 component overview lists `collapsible_panel` but has client version requirements.

**Pre-implementation verification**: send a test card with nested `collapsible_panel` via the current webhook before writing production code. The test card should contain one outer panel with one inner panel and a markdown element inside.

**Fallback if nested panels fail**: if the Lark client does not render nested `collapsible_panel` correctly in JSON 1.0 mode, fall back to **flat outer panels + markdown repo sections**:
- Outer `collapsible_panel` per significance tier (same header format, same expanded logic)
- Inside each outer panel: **markdown-only** repo sections instead of nested panels
- Format: `**{projectId} · {S} significant [· {R} routine]**\n{PR details...}` with `---` separators between repos
- This preserves the significance-first grouping and the drill-down UX without requiring nested panel support

This fallback is a graceful degradation, not a blocker — the rest of the UX improvements (signal truncation, significance grouping, expanded logic) work regardless of nesting support.

---

## Out of Scope

- Weekly card changes (deferred to WHI-136/141/143)
- Card interactivity
- `formatter.ts` threshold adjustments
- New significance levels or PR data model changes
