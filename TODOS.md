# TODOS

## Pipeline

### Periodic project overview refresh

**What:** Every 30 days, auto-regenerate project overview (LLM reads latest README + recent PRs + manifest).

**Why:** READMEs lag behind actual project direction by months. Stale overviews mislead LLM analysis, reducing the quality of significance classification and direction signals.

**Context:** M3 Issue 14 generates the initial overview from README + recent PRs + manifest. After that, there's no refresh mechanism. Add a monthly croner job that checks `projects.last_synced_at` for overview staleness and regenerates if > 30 days old. Cost is ~$0.01 per project per refresh.

**Effort:** S
**Priority:** P2
**Depends on:** M3 (post-MVP) — Issue 14 (Project Overview generation) complete
**Note:** Deferred to M3 (post-MVP) per CRG removal spec (`docs/spark/2026-05-29-remove-crg-from-mvp-design.md`)

## Completed
