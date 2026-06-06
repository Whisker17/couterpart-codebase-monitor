# Daily Card — Significance-First Grouping

**Date:** 2026-06-06  
**Status:** Draft (rev 5)
**Scope:** Daily card layout restructure — reorganize from repo-first to PR-significance-first grouping
**Supersedes:** Partially updates the panel logic from `2026-06-05-lark-card-ux-redesign.md`

---

## Background

Two issues observed in production daily cards:

1. **Summary signal truncation** — the 60-char hard limit in `buildSummaryContent` cuts off LLM-generated direction signals mid-sentence, losing the conclusion
2. **Repo details not reliably collapsed** — the old per-repo layout either expanded directional repo details directly or relied on nested panels that did not collapse reliably in production Lark JSON 1.0 cards

Additionally, the old flat per-repo panel list did not visually distinguish significance tiers. The user had to read each repo header emoji to understand which PRs were directional vs. notable.

---

## Grouping Model

**PR-significance-first grouping**: PRs are assigned to tiers by their own significance first, then grouped by repo inside each tier. A project with both directional and notable PRs can appear in both DIRECTIONAL and NOTABLE, but each tier contains only PRs of that tier.

Tiers:
- **DIRECTIONAL** — `directional_shift` PRs, grouped by repo
- **NOTABLE** — `notable` PRs, grouped by repo
- **Routine** — `routine` PRs do not get detail panels; they remain in summary/counts and may be omitted by formatter degradation

---

## Changes

This document contains two independently implementable changes:
- **Signal truncation**: replace the summary signal's 60-char hard cut with a byte-aware sentence-boundary soft cap.
- **Card grouping**: replace repo-first detail panels with PR-significance-first tier panels and repo markdown sections.

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

  // Find the code-unit offset where adding the next full code point would exceed byteCap.
  // `ch.length` keeps astral characters/surrogate pairs aligned with String.slice().
  let charLimit = 0;
  let bytes = 0;
  for (const ch of text) {
    const charBytes = Buffer.byteLength(ch, "utf-8");
    if (bytes + charBytes > byteCap) break;
    bytes += charBytes;
    charLimit += ch.length;
  }

  const slice = text.slice(0, charLimit);
  const boundaries = ["。", ". ", "！", "! ", "？", "? "];
  let lastBoundaryPos = -1;
  for (const marker of boundaries) {
    const idx = slice.lastIndexOf(marker);
    if (idx !== -1) {
      const pos = idx + marker.length;
      if (pos > lastBoundaryPos) lastBoundaryPos = pos;
    }
  }

  if (lastBoundaryPos > charLimit * 0.4) {
    return text.slice(0, lastBoundaryPos).trim();
  }

  return text.slice(0, charLimit).trim() + "…";
}
```

Rules:
- Default soft cap: **500 bytes** (~166 Chinese chars / ~500 English chars, enough for 1–2 sentences in either language)
- Walk the string char-by-char accumulating `Buffer.byteLength` to find the byte-safe cut point
- Within that range, truncate at the last sentence boundary (。 `. ` ！ `! ` ？ `? `)
- If no sentence boundary found in the first 40% of the range, fall back to hard cut + `…`
- `.trim()` before returning to clean up trailing whitespace from boundary detection
- `stripCounterpartRecommendations` still runs first to remove cross-repo noise before truncation

**Why 500 bytes, not unlimited**: A 10-repo card where every project uses the full 500-byte signal cap = 5KB of signal text alone. With panel and markdown section overhead, total remains well within the 20KB Level 1 threshold. Going unlimited would rely entirely on `formatter.ts` degradation, which only filters routine PRs — not signal text.

---

### 2. Significance-First Panels

Replace the current flat per-repo panel list with significance-tier panels. Lark JSON 1.0 did not reliably collapse nested `collapsible_panel` content in production, so repo grouping inside a tier uses markdown sections rather than nested panels.

**Outer panels** — one per significance tier present that day:
- `🔴 DIRECTIONAL · {N} repo(s) · {D} directional` — D = directional PR count in this tier
- `🟡 NOTABLE · {N} repo(s) · {B} notable` — B = notable PR count in this tier
- Use `repo` when `N = 1`, otherwise `repos`.

**Repo sections** — markdown sections inside the outer panel:
- `**{projectId} · {S} PR**`
- Followed by PR details for only that tier's PRs
- `---` separator between repos

Routine-only repos do not get panels (unchanged from current behavior).

#### Expanded state logic

- **DIRECTIONAL outer panel**: always `expanded: true` when present — so the reader immediately sees directional PRs
- **NOTABLE outer panel**: `expanded: true` only when no DIRECTIONAL panel exists; otherwise `expanded: false`

Priority order: DIRECTIONAL > NOTABLE.

This avoids nested panel compatibility issues while still keeping non-directional details collapsed behind the NOTABLE outer panel.

#### Repo sort order

Within each outer panel, repos are sorted deterministically:
1. Tier PR count descending (directional count for DIRECTIONAL tier, notable count for NOTABLE tier)
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
│  ▼ 🔴 DIRECTIONAL · 2 repos · 3 directional  [expanded]  │  outer
│     **reth · 2 PR**                                      │
│        #1234 async executor migration — summary...       │
│        Direction: ...                                    │
│        #1235 breaking change — summary...                │
│     ---                                                  │
│     **lighthouse · 1 PR**                                │
│        #5678 consensus API — summary...                  │
│                                                          │
│  ▶ 🟡 NOTABLE · 1 repo · 3 notable           [collapsed] │  outer
│     **geth · 3 PR**                                      │
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
  expanded: true, // DIRECTIONAL; NOTABLE uses !hasDirectional
  header: {
    title: {
      tag: "plain_text",
      content: "🔴 DIRECTIONAL · 2 repos · 3 directional"
    }
  },
  elements: [
    { tag: "markdown", content: "**reth · 2 PR**\nPR details...\n\n---\n\n**lighthouse · 1 PR**\nPR details..." }
  ]
}
```

#### Repo section body content

- Only PRs belonging to the outer tier: link, badge, summary, direction signal
- Routine PRs are omitted from detail sections
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
| Project has both directional + notable PRs | Directional PRs appear under DIRECTIONAL, notable PRs appear under NOTABLE. |
| `formatter.ts` Level 2 degradation | Routine-only projects filtered out before `buildDailyCard` — tier panels receive only notable/directional data, works as-is |
| `formatter.ts` Level 3 (per-project split) | `buildDailyCard(date, [singleProject], ...)` — single project produces at most one outer panel with one markdown repo section per tier |
| Signal text > 500 bytes | Truncated at last sentence boundary before byte cap; hard cut + `…` if no boundary found in first 40% of range |

---

### 4. Unchanged

- **Header color logic**: orange (any directional) / yellow (notable only) / blue (all routine)
- **Summary metric line format**: `{N} repos · {M} PR · 🔴 ×{n} · 🟡 ×{n} · ⚪ ×{n}`
- **Summary signal table**: per-project rows sorted by `projectSignificanceRank` (directional > notable > routine), same format (now with sentence-aware soft cap instead of hard 60-char cut)
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
1. Partition PRs into `directional` and `notable` tiers by PR significance, then group by `projectId` inside each tier
2. If both empty → return `[{ tag: "markdown", content: "_All PRs are routine today._" }]`
3. Build tier list in priority order: `[DIRECTIONAL, NOTABLE]`, filtering to non-empty tiers
4. DIRECTIONAL gets `expanded: true`; NOTABLE gets `expanded: !hasDirectional`
5. Within each tier, sort repos by: tier PR count desc → total PR count desc → `projectId` asc
6. Build markdown repo sections inside the outer panel
7. Outer panel header: `{emoji} {TIER_NAME} · {N} repo(s) · {D} {tier_label}`
8. Repo section header: `**{projectId} · {S} PR**`
9. Repo section body: same PR detail rendering, limited to the tier's PRs

Implementation decomposition:
- `groupProjectsByPrTier()` filters PRs by tier and returns repo groups with total repo PR count for sorting.
- `buildOuterTierPanel()` sorts one tier's repo groups and builds the outer `collapsible_panel`.
- `buildRepoMarkdownSections()` renders repo headers plus `---` separators into one markdown element.
- `renderPrDetails()` renders the tier PR links, badges, summaries, and direction signals.

**`buildDailyCard`** — update call from `buildRepoPanels` to `buildSignificancePanels`

### Type changes

`LarkCollapsiblePanel.elements` remains markdown-only for JSON 1.0 compatibility:
```typescript
export interface LarkCollapsiblePanel {
  tag: "collapsible_panel";
  expanded: boolean;
  header: { title: LarkText };
  elements: LarkMarkdownElement[];
}
```

---

## File Impact

| File | Change |
|------|--------|
| `daily-card.ts` | Add `truncateAtSentenceBoundary` (byte-aware), update `buildSummaryContent`, rename+rewrite `buildRepoPanels` → `buildSignificancePanels`, keep `LarkCollapsiblePanel` markdown-only for JSON 1.0 compatibility, update `buildDailyCard` call site |
| `daily-card.test.ts` | Update panel structure assertions for PR-significance tiers and markdown repo sections, update truncation-related tests, add byte-aware sentence-boundary tests (Chinese-heavy, English-heavy, mixed, no-boundary-found, under-cap-passthrough) |
| `report.test.ts` | Update oversize-card fixture if the new markdown-section structure changes card size |

No changes to: `formatter.ts`, `webhook.ts`, `weekly-card.ts`, `delivery-localizer.ts`, pipeline stages, data model.

---

## Lark Platform Constraints

- Nested `collapsible_panel` did not render reliably in the production JSON 1.0 card path, so the implementation uses only one collapsible level.
- `form` component is not allowed inside `collapsible_panel` (not relevant here)
- Avoid nested panels in production cards; repo sections stay as markdown inside the tier panel to preserve predictable collapse behavior on desktop and mobile.
- Current project uses **card JSON 1.0** (`elements` top-level array), not JSON 2.0 (`schema/body`). The JSON 1.0 component overview lists `collapsible_panel` but has client version requirements.

**Chosen compatibility path**: use **flat outer panels + markdown repo sections**:
- Outer `collapsible_panel` per significance tier (same header format, same expanded logic)
- Inside each outer panel: **markdown-only** repo sections instead of nested panels
- Format: `**{projectId} · {S} PR**\n{PR details...}` with `---` separators between repos
- This preserves significance-first grouping without relying on nested panel support

---

## Out of Scope

- Weekly card changes (deferred to WHI-136/141/143)
- Card interactivity
- `formatter.ts` threshold adjustments
- New significance levels or PR data model changes
