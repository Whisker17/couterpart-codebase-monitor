# Design Change: Remove code-review-graph from MVP, Diff-Aware Analysis

Date: 2026-05-29
Status: DRAFT (rev3 — addressing GPT 5.5 round-2 review)
Affects: `docs/design.md`, `docs/linear-design.md`, `CLAUDE.md`, `TODOS.md`

## Summary

Remove code-review-graph (CRG) from the MVP scope. Replace the two-phase analysis depth progression (M1: metadata-only → M2: CRG blast-radius) with a single diff-aware approach: feed raw PR diffs directly to the LLM. Restructure milestones from 4 to 3, and create a dedicated post-MVP milestone for CRG integration and other evolution features.

## Motivation

1. **Prompt quality is the first-order concern.** Real output from diff-aware analysis lets us iterate on prompts faster than investing in CRG infrastructure first.
2. **Modern LLMs read diffs well.** Claude Sonnet 4.6 can infer blast radius from diff content (imports, function signatures, file paths) at ~70-80% of CRG's precision — sufficient for MVP significance classification.
3. **Operational simplicity.** CRG adds Python 3.10 dependency, ~500MB/repo local clones, graph build/update lifecycle, disk budget management, and force-push rebuild logic. For a solo-maintained tool that runs unattended, fewer moving parts wins.
4. **CRG is a clean additive upgrade — with bounded integration cost.** The analyzer uses a generic `AnalysisContext` interface (see Section 2) with a `supplementaryContext` slot. CRG adds a new context provider that populates this slot. The prompt template, analyzer stage flow, and `analyzePR()` signature do not change — but CRG still requires its own infrastructure (Issues 11, 12) and prompt tuning to use the new context effectively. Not zero-cost, but well-bounded.
5. **Data-driven decision.** Running 2+ weeks of diff-aware analysis reveals the actual directional_shift detection accuracy, letting us decide CRG investment based on measured quality gaps rather than speculation.

## Changes

### 1. Issues Removed from MVP

| Issue | Title | Disposition |
|-------|-------|-------------|
| 11 | Local repo clone management | → Post-MVP M3 |
| 12 | code-review-graph bridge | → Post-MVP M3 |
| 13 | CRG blast-radius integration | → Post-MVP M3 |
| 14 | Project Overview generation | → Post-MVP M3 |

### 2. Issue 7 Upgrade: metadata-only → diff-aware

The M1 analyzer (Issue 7) currently sends only PR metadata + diff stats to the LLM. This change upgrades it to include the actual diff content, and introduces a generic `AnalysisContext` interface designed for future extensibility (CRG, project overview, etc.).

#### Generic analysis context interface

```ts
interface AnalysisContext {
  diff: TruncatedDiff | null;              // raw diff content (MVP)
  supplementaryContext: string | null;     // CRG blast-radius, etc. (post-MVP)
  projectContext: ProjectContextLite;      // lightweight project metadata (see Section 2b)
  inputQuality: "diff_aware" | "metadata_only" | "diff_plus_graph";
}
```

The `supplementaryContext` slot is null in the MVP. When CRG is added post-MVP, `crg-bridge.ts` becomes a context provider that populates this field — the `analyzePR()` signature, prompt template structure, and analyzer stage flow remain unchanged.

#### New module: `src/extensions/analyzer/diff-truncator.ts`

Responsible for preparing diff content for the LLM prompt within a token budget.

```ts
interface TruncatedDiff {
  content: string;          // truncated diff text
  fileManifest: FileEntry[];// ALWAYS complete — every file in the original diff
  totalFiles: number;
  includedFiles: number;
  truncated: boolean;
}

interface FileEntry {
  path: string;
  additions: number;
  deletions: number;
  included: boolean;        // was this file's diff content included?
  omitReason?: string;      // "lock_file" | "generated" | "budget" | null
}

function truncateDiff(rawDiff: string, tokenBudget?: number): TruncatedDiff;
```

**Truncation strategy:**

1. Parse diff into per-file hunks
2. Build complete `fileManifest` (always preserved — never truncated)
3. Classify each file into priority tiers:
   - **Skip always**: lock files (`package-lock.json`, `bun.lockb`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`), generated code (`*.generated.*`, `*.min.js`, `*.min.css`), binary files
   - **Tier 1 — Signal files**: files that frequently carry architectural/directional signals — `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `Dockerfile`, `docker-compose.*`, `*.proto`, `*.graphql`, `openapi.*`, `swagger.*`, CI configs (`.github/workflows/*`, `.gitlab-ci.yml`), migration files (`migrations/*`, `**/migrate*`), Kubernetes manifests (`k8s/*`, `*.yaml` with `apiVersion`)
   - **Tier 2 — Source code**: application source files (non-test, non-docs, non-config)
   - **Tier 3 — Tests**: test files (`*test*`, `*spec*`, `__tests__/`) — tests often reveal API behavior changes and are worth including when budget allows
   - **Tier 4 — Docs & other config**: documentation (`*.md`, `docs/`), linter/formatter config (`.eslintrc`, `.prettierrc`)
4. Within each tier, sort by change size descending (larger changes first)
5. Include files in tier order until token budget is reached
6. Append summary line: `"... {N} files omitted ({categories})"`
7. **Append file manifest** after the diff content (compact format: `path +N/-M [included|omitted: reason]`), so the LLM sees the complete change surface even when diff content is truncated. **Manifest cap:** if the PR touches >100 files, show the top 50 highest-signal files individually (Tier 1 + Tier 2 first, then by change size), then aggregate the rest by tier: `"... and 73 more files: 12 source, 45 tests, 16 docs"`. This prevents bulk-rename or vendor-commit PRs from blowing up the prompt. Cap is configurable via `settings.llm.maxManifestEntries` (default 100)

**Token budget:** Default 8000 tokens (~32000 chars). Configurable via `settings.llm.diffTokenBudget`.

**Edge cases:**
- Empty diff: return `{ content: "(empty diff)", ... }`
- Single large file exceeding budget: include first N lines of that file, note truncation
- Diff already within budget: return unchanged (all files included)

#### 2b. Lightweight Project Context (PROJECT CONTEXT LITE)

MVP does not generate full project overviews (Issue 14 deferred), but completely empty `PROJECT CONTEXT` weakens significance classification. Instead, construct a lightweight context from data already available:

```ts
interface ProjectContextLite {
  description: string | null;    // GitHub repo description (fetched by collector)
  language: string | null;       // GitHub primary language
  topics: string[];              // GitHub repo topics
  tags: string[];                // from projects.json config
  notes: string | null;          // from projects.json config
}
```

**Data sources:**
- `projects.json` already has optional `tags` and `notes` fields (Issue 4)
- GitHub repo metadata (description, language, topics) requires a `repos.get()` Octokit call — this is **one additional API call per project per sync**, not free. Issue 6 must add a `fetchRepoMetadata()` function and store the results in the `projects` table. This is a small addition (~10 lines) to the collector, and the API cost is negligible (one call per project, not per PR)

**Issue 6 additions:**
- New function: `fetchRepoMetadata(org, repo)` → calls `octokit.repos.get()`, returns `{ description, language, topics }`
- Collect stage writes these to `projects.description`, `projects.language`, `projects.topics` on each sync
- New acceptance criteria: `projects.description` populated after collect runs; `projects.language` and `projects.topics` are valid (language is a string, topics is a JSON array)

**Schema addition:**
```sql
-- Add to projects table (new columns, nullable, no migration needed for greenfield)
ALTER TABLE projects ADD COLUMN description TEXT;
ALTER TABLE projects ADD COLUMN language TEXT;
ALTER TABLE projects ADD COLUMN topics TEXT;  -- JSON array
```

**Prompt injection:**
```
PROJECT CONTEXT:
{project.description or "No description available."}
Language: {project.language or "Unknown"}
Topics: {project.topics.join(", ") or "None"}
{if project.notes: "Notes: " + project.notes}
{if project.tags.length: "Tags: " + project.tags.join(", ")}
```

This is significantly better than empty context for significance classification. The full LLM-generated overview (Issue 14) remains a post-MVP upgrade.

#### LLM prompt change

Replace `CODE-REVIEW-GRAPH CONTEXT` section with a generic `SUPPLEMENTARY CONTEXT` slot:

```
PROJECT CONTEXT:
{projectContextLite — see Section 2b}

PR INFORMATION:
Title: {pr.title}
Author: {pr.author}
Files changed: {pr.files_changed} (+{pr.additions}/-{pr.deletions})
PR Body: {pr.body (truncated to 1000 chars)}

DIFF CONTENT:
{truncated_diff.content or "Diff not available — analysis based on PR metadata only."}
{if truncated: "(Diff truncated: showing {includedFiles}/{totalFiles} files within token budget)"}
{fileManifest in compact format}

SUPPLEMENTARY CONTEXT:
{analysisContext.supplementaryContext or "Not available."}
```

The `SUPPLEMENTARY CONTEXT` section is the extensibility slot. In MVP it's always "Not available." When CRG is added, it fills this slot with blast-radius data. When project overview is added, it enriches `PROJECT CONTEXT`. Neither change requires modifying the prompt template structure.

#### Issue 6 change: Collector stores raw diff without truncation

Original Issue 6 truncates diffs >500KB at the collector stage (`diff-fetcher.ts`). This conflicts with the analyzer's intelligent per-file truncation — if the collector already cut the diff, the analyzer can't make priority-based decisions about which files to include.

**Change:** Collector stores the complete raw diff. No size-based truncation in `diff-fetcher.ts`. All truncation happens in `diff-truncator.ts` at prompt construction time.

Handle very large diffs (>2MB) as an edge case: store a marker file instead (`"DIFF_TOO_LARGE: {size} bytes"`), and the analyzer falls back to metadata-only analysis for that PR. This threshold is high enough that virtually no normal PR hits it, but prevents disk abuse from pathological cases (committed binaries, vendor directories).

#### Diff status modeling

The `pull_requests` table gets a new `diff_status` column to distinguish between different diff availability states. This prevents the analyzer from accidentally treating a `DIFF_TOO_LARGE` marker file as real diff content.

```sql
-- Add to pull_requests table (greenfield, no migration)
diff_status TEXT CHECK(diff_status IN ('available', 'missing', 'fetch_failed', 'too_large')) DEFAULT 'missing'
```

The collector sets this when storing diffs:
- Normal diff stored → `diff_status = 'available'`, `diff_path = '...'`
- GitHub API returned no diff → `diff_status = 'missing'`, `diff_path = NULL`
- Diff fetch failed (network/API error) → `diff_status = 'fetch_failed'`, `diff_path = NULL`
- Diff >2MB → `diff_status = 'too_large'`, `diff_path = NULL` (no marker file — status column is the marker)

The analyzer checks `diff_status` rather than testing `diff_path` existence:

```ts
if (pr.diff_status === "available" && pr.diff_path) {
  // read and truncate
} else {
  // metadata_only — inputQuality reflects the reason
}
```

#### Analysis input persistence

Analysis inputs must be captured at analysis time, not reconstructed later. If the prompt template or truncator logic changes, after-the-fact reconstruction won't match what the LLM actually saw.

**New table: `analysis_inputs`**

```sql
CREATE TABLE IF NOT EXISTS analysis_inputs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES analyses(id),
  prompt_version TEXT NOT NULL,         -- hash or version tag of the prompt template
  input_quality TEXT NOT NULL,          -- "diff_aware" | "metadata_only"
  rendered_project_context TEXT,        -- the exact PROJECT CONTEXT block sent to LLM
  file_manifest TEXT,                   -- JSON array of FileEntry objects
  diff_included_files INTEGER,          -- count of files whose diff content was included
  diff_total_files INTEGER,             -- total files in the PR
  diff_truncated BOOLEAN NOT NULL,
  truncated_diff_path TEXT,             -- path to stored truncated diff snapshot (data/analysis-inputs/{analysis_id}.diff)
  created_at INTEGER DEFAULT (unixepoch())
);
```

The analyzer writes to this table immediately after each successful LLM call, in the same transaction as the `analyses` insert. The truncated diff content (what the LLM actually saw) is stored to `data/analysis-inputs/{analysis_id}.diff` — not in the DB (too large for SQLite blobs at scale).

Issue 16a's audit export CLI simply joins `analyses` + `analysis_inputs` and exports to JSONL. No reconstruction needed.

**Retention:** `analysis_inputs` rows and their `.diff` files follow the same 30-day retention as raw diffs. After 30 days, the `.diff` snapshot is deleted but the metadata row remains (prompt_version, file_manifest, truncation stats) for long-term quality tracking.

#### Analyzer stage flow change

```ts
// Before (Issue 7 original):
// query pending PR → call LLM (metadata only) → write analysis

// After (this change):
// query pending PR → build AnalysisContext → call LLM → persist analysis + inputs → write to DB

for (const pr of pendingPRs) {
  // Budget hard cap check (see Section 4)
  if (isBudgetExhausted()) {
    result.budgetExhausted = true;
    result.budgetSkippedCount = remainingPRs.length;
    log.warn(`[Budget] Hard cap reached. ${result.budgetSkippedCount} PRs left pending.`);
    break;
  }

  const project = getProject(pr.project_id);

  // Build analysis context — diff_status gates diff reading
  let diff: TruncatedDiff | null = null;
  if (pr.diff_status === "available" && pr.diff_path) {
    const rawDiff = await Bun.file(pr.diff_path).text();
    diff = truncateDiff(rawDiff, settings.llm.diffTokenBudget);
  }

  const ctx: AnalysisContext = {
    diff,
    supplementaryContext: null,  // CRG slot — null in MVP
    projectContext: buildProjectContextLite(project),
    inputQuality: pr.diff_status === "available" && diff ? "diff_aware" : "metadata_only",
  };

  const analysis = await analyzePR(pr, ctx);

  // Persist analysis + inputs in same transaction
  db.transaction(() => {
    const analysisId = insertAnalysis(analysis);
    insertAnalysisInput(analysisId, ctx);       // writes analysis_inputs row
    saveTruncatedDiff(analysisId, ctx.diff);    // writes .diff snapshot file
    updatePRStatus(pr.id, "complete");
  });
}
```

### 3. Issue 16 Split: Prompt Baseline (M1) + Data-Driven Tuning (M2)

Original Issue 16 requires real data accumulation and A/B comparison, which can't happen within M1. Split into two:

**Issue 16a (M1): Prompt Baseline + Audit Infrastructure**
- Finalize the baseline prompt (system prompt, significance rubric, output schema) as part of the M1 pipeline
- Build audit export CLI: joins `analyses` + `analysis_inputs` tables, exports to JSONL for manual review (no reconstruction — reads persisted inputs)
- Blocked by: Issue 7 (analyzer must exist to build audit tooling on top of it)
- This makes M1 independently deliverable: pipeline runs, produces reports, and provides tooling to evaluate quality

**Issue 16b (M2/Harden): Data-Driven Prompt Tuning**
- Requires 5+ days of real analysis data from M1
- Human review of exported analyses, identify misclassifications
- A/B prompt comparison on the same PR set
- Adjust significance rubric and prompt based on findings
- Blocked by: Issue 16a + Issue 10

**Issue 10 update:** End-to-end validation now also covers audit export and weekly reports. Blocked by: 6, 7, 8, 9, 15, 16a (was: 6, 7, 8, 9). This ensures the final M1 validation exercises all M1 deliverables including audit infrastructure.

This ensures M1 is a complete deliverable (daily + weekly reports with baseline prompts + audit tooling) and M2 improves quality based on evidence.

### 4. Budget Guard in M1

With diff-aware analysis nearly doubling token consumption, running M1 without any budget controls risks unexpected costs. Add a lightweight budget guard to M1 (Issue 7), while keeping Issue 21's full dashboard/fine-grained strategy in M2.

**M1 budget guard (added to Issue 7):**

```ts
// Before each PR analysis:
const estimatedInputTokens = estimateTokens(prompt);  // simple char/4 heuristic
const monthlyUsage = db.query(
  "SELECT SUM(tokens_used) as total FROM analyses WHERE analyzed_at >= ?"
).get(monthStart);

const estimatedCost = (monthlyUsage.total + estimatedInputTokens) * COST_PER_TOKEN;
if (estimatedCost > settings.budget.monthlyCap) {
  log.warn(`[Budget] Hard cap reached: ~$${estimatedCost.toFixed(2)} / $${settings.budget.monthlyCap}. Skipping remaining analyses.`);
  break;  // stop analyzing for this pipeline run
}
```

**State semantics when cap is hit:**
- Remaining PRs stay `analysis_status = 'pending'` — they are not failed, just deferred
- `StageResult` records `budgetExhausted: true` and `budgetSkippedCount: N`
- Pipeline log emits a clear warning: `[Budget] Hard cap reached: ~$X / $Y. N PRs left pending for next month.`
- Report stage checks `ctx.stageResults.get("analyze").budgetExhausted` — if true, adds a line to the daily report: `"⚠ Budget cap reached — {N} PRs not analyzed this cycle"`
- Next pipeline run: if budget is still exhausted (same month), the analyzer skips immediately with the same warning. PRs accumulate as `pending` and are processed when the monthly budget resets or the cap is raised

**StageResult extension:**
```ts
interface StageResult {
  // ... existing fields
  budgetExhausted?: boolean;    // true if hard cap stopped analysis
  budgetSkippedCount?: number;  // PRs left pending due to budget
}
```

**Scope:** Hard cap + visible state only. No skip-routine logic, no dashboard, no Lark budget alerts — those are Issue 21 (M2). This is a safety net with clear observability, not a feature.

### 5. Data Retention: Extend Diff Retention for Prompt Tuning

Original design deletes diff files 24 hours after analysis completes. But Issue 16b (prompt tuning) needs to re-run analyses on the same PRs with new prompts, which requires the original diff input.

**Change:** Extend diff retention from 24 hours to 30 days after analysis completion.

```ts
// In maintenance.ts:
// Before: DELETE diffs where analysis_status = 'complete' AND fetched_at < 24h ago
// After:  DELETE diffs where analysis_status = 'complete' AND fetched_at < 30 days ago
```

The audit export (Issue 16a) reads from the persisted `analysis_inputs` table — no reconstruction needed. Export format:

```jsonl
{"pr_id": 42, "project_id": "vercel/next.js", "pr_number": 12345, "input": {"prompt_version": "v1.0-abc123", "diff_truncated": true, "included_files": 8, "total_files": 15, "input_quality": "diff_aware", "rendered_project_context": "...", "file_manifest": [...]}, "output": {"summary": "...", "significance": "notable", ...}, "tokens_used": 3200}
```

Because inputs are persisted at analysis time (see Section 2), the export is always faithful to what the LLM actually saw — even if the prompt template or truncator logic has since changed. After `.diff` snapshot files are deleted (>30 days), the metadata row still provides prompt version, file manifest, truncation stats, and project context for long-term quality tracking.

### 6. Milestone Restructuring

**Before (4 milestones):**

| Milestone | Name | Issues |
|-----------|------|--------|
| M0 | Scaffold + pi-agent Learning | 1, 2, 3, 4 |
| M1 | Lightweight Daily Pipeline (API-only) | 5, 6, 7, 8, 9, 10 |
| M2 | Deep Analysis + Weekly Reports | 11, 12, 13, 14, 15, 16 |
| M3 | Polish + Harden | 17, 18, 19, 20, 21, 22, 23 |

**After (3 milestones + post-MVP):**

| Milestone | Name | Issues | Target |
|-----------|------|--------|--------|
| M0 | Scaffold + pi-agent Learning | 1, 2, 3, 4 | 2026-06-04 |
| M1 | Core Pipeline (Daily + Weekly) | 5, 6*, 7*, 8, 9, 10, 15, 16a | 2026-06-16 |
| M2 | Harden | 16b, 17, 18, 19, 20, 21, 22, 23* | 2026-06-25 |
| M3 (post-MVP) | Deep Analysis + Evolution | 11, 12, 13, 14, + evolution items | TBD |

`*` = modified issue

**M1 changes:**
- Issue 6 modified: collector stores raw diff without truncation (see Section 2)
- Issue 7 upgraded: diff-aware analysis + `AnalysisContext` interface + PROJECT CONTEXT LITE + budget hard cap (see Sections 2, 4)
- Issue 15 (Weekly Report) absorbed from old M2, blocked by Issue 8 only
- Issue 16a (Prompt Baseline + Audit Export) is the M1-scoped portion of old Issue 16

**M2 changes:**
- Renumbered from old M3 to M2
- Issue 16b (Data-Driven Prompt Tuning) added, blocked by 16a + 10
- Issue 23 (production deployment): remove `Python >= 3.10` and `code-review-graph` from environment requirements

### 7. Post-MVP Milestone: M3 Deep Analysis + Evolution

A dedicated milestone collecting all deferred CRG work and evolution features from TODOS.md and the design doc's "Evolution Path to Approach C."

**Entry gate:** M2 (Harden) complete. All post-MVP issues are blocked by M2 completion — not individual MVP issues — to prevent premature starts while hardening is in progress.

| Issue | Title | Blocked By | Notes |
|-------|-------|------------|-------|
| 11 | Local repo clone management | M2 complete | Prerequisite for CRG and full overview |
| 12 | code-review-graph bridge | 11 | CRG CLI wrapper |
| 13 | CRG blast-radius integration | 12 | Populates `supplementaryContext` slot |
| 14 | Project Overview generation (full) | 11 | LLM reads README + manifest from clone, upgrades PROJECT CONTEXT LITE to full overview |
| NEW | Periodic overview refresh | 14 | Currently in TODOS.md as P2 |
| NEW | Narrative drift detection | 14 | Evolution path from design.md |
| NEW | Cross-project trend engine | M2 complete | Evolution path from design.md |

This milestone has no target date. It starts when MVP is stable and we have quality data showing where CRG would measurably improve analysis.

### 8. Dependency Graph Update

```
M0 (Scaffold):
  1 ─┬── 2 ──┐
     ├── 3 ──┼── 5
     └── 4 ──┘

M1 (Core Pipeline):
  5 ─┬── 6* ──┬── 7* ──┬── 8 ──── 9 ──┐
     │        │        │              │
     │        └────────┴──────────────┘
     └───────────────────── (stage skeletons)
  8 ── 15 (weekly report, absorbed from old M2)
  7 ── 16a (prompt baseline + audit export)
  6 + 7 + 8 + 9 + 15 + 16a ── 10 (end-to-end validation)

M2 (Harden):
  10 ── 17 ── 18
         │
    17 ── 23*
   7 ── 21
   9 ── 19
  10 ── 20
  16a + 10 ── 16b (data-driven prompt tuning)
  16b ── 22

M3 (Post-MVP, gated by M2 complete):
  M2 ── 11 ── 12 ── 13
         │
         └── 14
```

**Blocking table (updated):**

| Issue | Blocked By |
|-------|------------|
| 1 | (none) |
| 2 | 1 |
| 3 | 1 |
| 4 | 1 |
| 5 | 2, 3, 4 |
| 6 | 2, 4, 5 |
| 7 | 5, 6 |
| 8 | 7 |
| 9 | 4, 8 |
| 15 | 8 |
| 16a | 7 |
| 10 | 6, 7, 8, 9, 15, 16a |
| 16b | 16a, 10 |
| 17 | 10 |
| 18 | 17 |
| 19 | 9 |
| 20 | 10 |
| 21 | 7 |
| 22 | 16b |
| 23 | 17 |
| 11 | M2 complete |
| 12 | 11 |
| 13 | 12 |
| 14 | 11 |

### 9. Settings Change

Add `diffTokenBudget` to settings:

```ts
interface Settings {
  llm: {
    model: string;
    apiKeyEnvVar: string;
    maxTokensPerCall: number;
    diffTokenBudget: number;   // NEW: default 8000
    maxManifestEntries: number; // NEW: default 100
  };
  // ... rest unchanged
  budget: {
    monthlyCap: number;        // default: 80 (was 50)
    warningThreshold: number;
    cutoffThreshold: number;
  };
  // clone section removed from MVP settings
  // clone: { reposDir, initialDepth } → deferred to M3
}
```

### 10. Cost Model Update

| Metric | Before (metadata-only) | After (diff-aware) |
|--------|----------------------|-------------------|
| Input tokens/PR | ~2,500 | ~6,000-10,000 |
| Output tokens/PR | ~300 | ~300-400 |
| Cost/PR | ~$0.01 | ~$0.02-0.04 |
| Monthly (10 repos, 5 PRs/day) | ~$20-35 | ~$35-65 |
| Budget cap default | $50 | $80 |

M1 has a hard budget cap as a safety net (see Section 4). Issue 21 (M2) adds skip-routine logic at 80%, pause at 100%, dashboard in daily reports, and Lark alerts.

### 11. Directory Structure Update

```
src/
├── index.ts
├── config/
│   ├── projects.ts
│   └── settings.ts
├── extensions/
│   ├── github-collector/
│   │   ├── index.ts
│   │   ├── fetcher.ts
│   │   └── diff-fetcher.ts
│   ├── analyzer/
│   │   ├── index.ts
│   │   ├── llm-reviewer.ts
│   │   ├── significance.ts
│   │   ├── diff-truncator.ts      # NEW (replaces crg-bridge.ts)
│   │   └── context.ts             # NEW: AnalysisContext interface + builders
│   ├── report-generator/
│   │   ├── index.ts
│   │   ├── daily.ts
│   │   ├── weekly.ts
│   │   └── templates/
│   │       ├── daily-card.ts
│   │       └── weekly-card.ts
│   └── lark-dispatcher/
│       ├── index.ts
│       ├── webhook.ts
│       └── formatter.ts
├── pipeline/
│   ├── runner.ts
│   ├── maintenance.ts
│   └── stages/
│       ├── collect.ts
│       ├── analyze.ts
│       ├── report.ts
│       └── dispatch.ts
├── storage/
│   ├── db.ts
│   ├── schema.ts
│   └── migrations/
├── scheduler/
│   └── cron.ts
└── utils/
    ├── retry.ts
    ├── rate-limiter.ts
    └── budget-tracker.ts
data/                               # SQLite db + diffs (gitignored)
config/                             # JSON config files
```

No `repos/` directory. No `clone-manager.ts`. No `crg-bridge.ts`. No `overview-generator.ts`.

### 12. Schema Changes Summary

**New columns on `projects` table** (greenfield, no migration needed):
```sql
description TEXT,   -- GitHub repo description
language TEXT,      -- GitHub primary language
topics TEXT,        -- JSON array of GitHub topics
```

**New column on `pull_requests` table:**
```sql
diff_status TEXT CHECK(diff_status IN ('available', 'missing', 'fetch_failed', 'too_large')) DEFAULT 'missing'
```

**New table: `analysis_inputs`** (see Section 2 for full DDL):
Persists the exact inputs the LLM saw at analysis time. Joined with `analyses` for audit export (Issue 16a). Metadata rows kept indefinitely; `.diff` snapshot files follow 30-day retention.

**All other existing tables:** unchanged. `clone_path`/`overview`/`tech_stack` on `projects` remain but are null in MVP.

### 13. Files to Update (when implementing)

| File | Change |
|------|--------|
| `docs/design.md` | Update architecture, remove CRG sections, update cost model, update directory structure, update pipeline flow, add post-MVP evolution section, add PROJECT CONTEXT LITE, update diff handling |
| `docs/linear-design.md` | Move Issues 11-14 to new M3 section, update milestone table, update dependency graph, update Issue 6 (no collector truncation), update Issue 7 (diff-aware + context interface + budget guard), split Issue 16 into 16a/16b, update Issue 23 environment requirements |
| `CLAUDE.md` | Remove CRG from tech stack, remove clone constraints, update directory structure, remove Python dependency, update budget numbers, add diff-truncator and context.ts to architecture description |
| `TODOS.md` | Move "periodic overview refresh" to M3 milestone reference |
| `docs/eng-review-learnings.md` | Add note that CRG learnings (items 2, 5) are deferred to post-MVP |

### 14. What Doesn't Change

- Pipeline architecture (4-stage sequential, SQLite communication)
- pi-agent usage pattern (LLM tool registration only, not pipeline orchestration)
- Lark card format and message size strategy
- Scheduling model (croner, daily + weekly)
- Error handling and retry patterns (M2)
- All M0 issues (1, 2, 3, 4)
- M1 issues 5, 8, 9 (unchanged)
- All hardening issues (17-23, except 23's env requirements)

### 15. Review Change Log

**Rev 3 (2026-05-29) — addressing GPT 5.5 round-2 review, 5 contract issues fixed:**

1. **[P1] Analysis inputs persisted at analysis time.** New `analysis_inputs` table written in the same transaction as `analyses`. Stores prompt_version, rendered project context, file manifest, truncation metadata, and a `.diff` snapshot of the exact truncated diff the LLM saw. Audit export (Issue 16a) reads from this table — no reconstruction needed, faithful even if prompt/truncator logic changes later.
2. **[P1] Issue 16a dependency direction fixed.** 16a now blocked by Issue 7 (not 10). Issue 10 now blocked by 6, 7, 8, 9, 15, 16a — end-to-end validation exercises all M1 deliverables including audit infrastructure.
3. **[P2] PROJECT CONTEXT LITE data source corrected.** Acknowledged `repos.get()` is a new API call (one per project per sync, not free). Added `fetchRepoMetadata()` to Issue 6 scope with explicit acceptance criteria.
4. **[P2] Diff status explicitly modeled.** New `diff_status` column on `pull_requests` (`available | missing | fetch_failed | too_large`). Analyzer checks status column instead of testing file existence. No marker files — the column is the marker. >2MB diffs get `diff_status = 'too_large'`, `diff_path = NULL`.
5. **[P2] Budget guard state semantics added.** `StageResult` extended with `budgetExhausted` and `budgetSkippedCount`. PRs stay `pending` (not a new status). Report stage adds budget warning line to daily report. Log emits clear warning. Next run skips immediately if budget still exhausted.
6. **[P3] File manifest capped.** >100 files: show top 50 individually, aggregate rest by tier. Configurable via `settings.llm.maxManifestEntries`.

**Rev 2 (2026-05-29) — addressing GPT 5.5 review, 8 issues fixed:**

1. **"零重构" overclaim fixed.** Replaced with honest "well-bounded integration cost" framing. Introduced generic `AnalysisContext` interface with `supplementaryContext` slot so CRG adds a context provider without changing analyzer contract.
2. **Diff truncation strategy redesigned.** Added "signal files" priority tier (package.json, Dockerfile, proto, CI, migrations, K8s). Tests promoted from "deprioritize" to their own tier above docs. Full `fileManifest` always preserved and appended to prompt, so LLM sees complete change surface even when diff content is truncated.
3. **Collector truncation removed.** Collector now stores raw diff without any size-based truncation. All truncation happens in `diff-truncator.ts` at prompt construction time. Very large diffs (>2MB) stored as `diff_status = 'too_large'` and fall back to metadata-only analysis.
4. **Issue 16 split.** 16a (M1): baseline prompt + audit export infrastructure. 16b (M2): data-driven tuning with A/B comparison. M1 is now independently deliverable.
5. **Budget guard added to M1.** Hard cap safety net in Issue 7 — simple monthly cost check before each analysis. Full dashboard/skip-routine/alerts remain in Issue 21 (M2).
6. **PROJECT CONTEXT LITE added.** Lightweight project context from GitHub API metadata (description, language, topics) + projects.json (tags, notes). Three new columns on projects table. Significantly better than empty context for significance classification.
7. **Diff retention extended to 30 days.** Was 24 hours. Analysis inputs persisted at analysis time via `analysis_inputs` table for long-term quality tracking.
8. **Post-MVP dependency consistency fixed.** All M3 issues gated by "M2 complete" rather than individual MVP issue numbers. Prevents premature starts during hardening.
