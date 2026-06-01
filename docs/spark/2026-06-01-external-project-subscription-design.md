# External Project Subscription Design

Date: 2026-06-01
Status: Approved for implementation planning

## Problem

Counterpart Monitor currently reads tracked repositories from `config/projects.json` and caches the list in process memory. Updating the monitored repository set requires changing a local file and restarting or otherwise forcing the process to reload. This blocks centralized management: a separate repository cannot own the canonical monitor subscription list, and production cannot pick up repository additions/removals without redeploying or restarting.

## Goal

Add an external project subscription mode where the monitor can fetch a JSON subscription source at the start of each pipeline run, sync the active repository set into SQLite, and continue running without a process restart. The external JSON should be simple to maintain in another repo and should stay close to the current local JSON format.

## Non-Goals

- Do not add a UI for managing subscriptions.
- Do not add second-by-second background polling.
- Do not delete historical PRs, analyses, reports, or diff artifacts when a repo is removed from the subscription.
- Do not support non-GitHub repositories in this iteration.

## Chosen Approach

Use a per-run subscription refresh at the beginning of collection.

On each pipeline run, the monitor resolves the tracked project snapshot from either:

1. the external subscription JSON URL in `PROJECTS_SUBSCRIPTION_URL` when configured, or
2. local `config/projects.json` when no subscription URL is configured.

If the external subscription fetch and validation succeed, the monitor syncs the result into SQLite and collection uses that same active snapshot for the rest of the run. If the external source fails, times out, or validates badly, the monitor does not mutate the subscription state; it logs the error and continues from the last successful active SQLite subscription snapshot. If there is no previous successful subscription snapshot, collection fails early with a clear error. Local JSON is only a fallback when `PROJECTS_SUBSCRIPTION_URL` is not configured.

This makes subscription-mode cold starts explicit: the first pipeline run with `PROJECTS_SUBSCRIPTION_URL` set requires that URL to be reachable and valid. There is no local JSON bootstrap in subscription mode.

## Subscription JSON Format

The external subscription format requires `url` as the identity field. `org` and `repo` are derived from the GitHub URL.

```json
[
  {
    "url": "https://github.com/base/base",
    "tags": ["blockchain", "l2", "ethereum"],
    "notes": "optional analyst context"
  },
  {
    "url": "https://github.com/ethereum-optimism/optimism",
    "tags": ["blockchain", "optimism"]
  }
]
```

Rules:

- `url` is required and must identify a GitHub repository.
- Valid URL forms include `https://github.com/{org}/{repo}`. `http://github.com/{org}/{repo}` is accepted and normalized to HTTPS. A trailing slash or `.git` suffix is normalized away.
- `org` and `repo` are parsed from `url` and used internally as the stable project ID `{org}/{repo}`.
- `tags` is optional and defaults to an empty array.
- `notes` is optional and defaults to absent.
- Duplicate project IDs in one subscription source are invalid.
- Unknown fields should be ignored rather than failing validation.

The existing local `config/projects.json` can remain backward-compatible with explicit `org` and `repo` fields for now, but the internal normalized project type should always be:

```ts
{
  org: string;
  repo: string;
  url: string;
  tags?: string[];
  notes?: string;
}
```

## Configuration

Add project subscription settings under the existing settings/config pattern:

- `PROJECTS_SUBSCRIPTION_URL`: read directly from `process.env`; do not add a second-level `subscriptionUrlEnvVar` indirection;
- `projects.fetchTimeoutMs`: defaults to `10000`;
- local JSON fallback behavior when no subscription URL is configured.

Production should be able to run fully from the external subscription source. Local development should still work without any external URL by reading `config/projects.json`.

## Architecture

`src/config/projects.ts` should become the public facade for resolving project snapshots instead of permanently caching a local file. Existing callers can keep depending on project-resolution functions, but remote data must not be held in a process-global cache that prevents hot updates.

Recommended module responsibilities:

- Project parser/validator: pure logic for URL parsing, duplicate detection, defaulting, and normalization.
- Subscription fetcher: reads the external JSON using Bun `fetch`, applies timeout handling, and returns typed parse results without touching SQLite.
- Project resolver: chooses external subscription when `PROJECTS_SUBSCRIPTION_URL` is configured or local JSON when it is not configured, and returns a per-run normalized snapshot plus source metadata.
- SQLite sync helper: applies a successful subscription snapshot to the `projects` table inside one transaction and returns the active project list for the run.
- Collect stage integration: runs project resolution/sync before fetching GitHub metadata and PRs.

Analysis context can continue to use normalized tags and notes for prompt context, but it must use the active resolved snapshot or a fresh project metadata lookup instead of a stale module-level cache.

## SQLite State

SQLite remains the durable runtime state for project lifecycle. Add lightweight source/status fields to `projects` so the monitor can distinguish:

- active projects from the current subscription,
- projects removed from the subscription,
- projects marked inactive because GitHub returned repo-not-found,
- local-fallback projects used for development or emergency operation.

Add these columns:

- `source TEXT NOT NULL DEFAULT 'local'`: one of `local` or `subscription`.
- `inactive_reason TEXT`: one of `subscription_removed`, `repo_not_found`, `manual`, or `NULL`.
- `subscription_synced_at INTEGER`: Unix timestamp of the latest successful subscription sync touching this row.

The existing `active` column continues to represent whether the monitor should collect the project. A successful subscription sync sets subscribed rows to `source = 'subscription'`, `active = 1`, and `inactive_reason = NULL`. Subscription-managed rows absent from the latest successful source become `active = 0` and `inactive_reason = 'subscription_removed'`. The removal query must be constrained to `source = 'subscription'`; subscription sync must not deactivate local-mode rows. If a removed project reappears later, it is reactivated. The existing `last_synced_at` column keeps its current GitHub PR collection meaning and must not be reused for subscription sync tracking.

Migration/backfill requirements:

- Existing rows with `active = 0` and no `inactive_reason` should be backfilled to `repo_not_found`, because the current application code only deactivates rows automatically on `RepoNotFoundError`.
- Future `RepoNotFoundError` handling must set `inactive_reason = 'repo_not_found'`.
- `manual` is reserved for explicit operator-driven deactivation.
- Subscription removal must set `inactive_reason = 'subscription_removed'`.

Source semantics:

- In normal subscription mode, successful subscription syncs write `source = 'subscription'`.
- In no-subscription-URL mode, local JSON rows use `source = 'local'`.
- If `PROJECTS_SUBSCRIPTION_URL` is configured but fetch/validation fails, local JSON must not be loaded as a mutating fallback. Use the last successful SQLite subscription snapshot or fail clearly if none exists.
- Subscription sync only deactivates rows with `source = 'subscription'`; it must not deactivate local-mode rows.
- Switching from subscription mode back to local mode by removing `PROJECTS_SUBSCRIPTION_URL` does not automatically deactivate previously active subscription rows. They remain in SQLite until an operator explicitly deactivates them or a later cleanup issue defines a migration path. This is accepted known behavior for WHI-146 and should be documented after implementation.

Caching/conditional fetch is out of scope for WHI-146. A full JSON fetch once per pipeline run is acceptable for the current repo count and keeps failure semantics simpler. ETag/hash support can be revisited as a separate issue if the subscription grows large or the host rate-limits raw file reads.

Historical rows in `pull_requests`, `analyses`, `analysis_inputs`, `reports`, and `report_deliveries` must not be deleted as part of subscription sync.

## Runtime Data Flow

At the start of each collection run:

1. Load project subscription configuration.
2. If an external subscription URL is configured, fetch it with the configured timeout.
3. Parse and validate the JSON entries.
4. Derive `org/repo` from each GitHub URL and normalize entries.
5. On successful external fetch and validation:
   - execute subscription sync in a single SQLite transaction,
   - upsert all subscribed projects with active status,
   - update `url` and config-derived metadata when needed,
   - mark subscription-managed projects absent from the new source as inactive with a subscription-removal reason, constrained to rows with `source = 'subscription'`,
   - keep unrelated historical rows untouched.
6. Build the active project snapshot for the current run.
7. Fetch GitHub metadata, merged PRs, PR stats, and diffs only for that active snapshot.

If external fetch or validation fails:

1. log the subscription error clearly;
2. do not mutate subscription-managed project state;
3. use the last successful active SQLite snapshot if one exists;
4. fail collection early if no successful subscription snapshot exists.

## Reporting And Completeness

Daily report completeness should use the active resolved project snapshot for the run, not the bundled local JSON file. Projects intentionally removed from the subscription should not count as failed or missing in future reports. Projects that fail collection or analysis during the run should continue to appear in partial-report warnings as they do today.

When a successful subscription sync changes the active project set, the daily report or report metadata should include a concise note, for example: `3 projects removed from subscription: org/a, org/b, org/c`.

## Error Handling

Subscription failures are non-destructive. A bad external file should not deactivate every project.

Validation errors should include enough detail to fix the source JSON, such as:

- invalid GitHub URL,
- duplicate repository ID,
- missing required `url`,
- top-level JSON is not an array.

If a subscribed GitHub repo later returns not found during collection, keep the existing behavior of marking that project inactive, but record an inactive reason distinct from subscription removal.

## Testing Strategy

Unit tests:

- URL-only subscription entries derive correct `org` and `repo`.
- Trailing slash and `.git` URL variants normalize correctly.
- `http://github.com/{org}/{repo}` normalizes to `https://github.com/{org}/{repo}`.
- Missing `url`, non-GitHub URLs, malformed JSON, and duplicate repos fail validation.
- Unknown fields are ignored.
- Existing local JSON entries with explicit `org` and `repo` remain supported.

Sync tests:

- Successful subscription sync inserts new projects as active.
- Existing projects are updated and remain active.
- Subscription-managed projects absent from the latest successful source are marked inactive.
- Subscription removal only deactivates rows with `source = 'subscription'`.
- Removed projects are reactivated when they reappear.
- Historical PR and analysis rows remain intact.
- Failed external fetch or validation does not mutate project status.
- Subscription sync is transactional; a simulated mid-sync failure leaves active/source/inactive_reason state unchanged.

Pipeline tests:

- Collect uses the active subscription snapshot for the whole run.
- Failed subscription fetch falls back to the last successful SQLite snapshot.
- Failed subscription fetch with no previous successful subscription snapshot fails collection clearly instead of bootstrapping from local JSON.
- First pipeline run with `PROJECTS_SUBSCRIPTION_URL` set requires a reachable, valid subscription source.
- With no subscription URL, local `config/projects.json` behavior still works.
- Report completeness counts active resolved projects, not stale local JSON.
- Report metadata or daily report output includes a concise subscription-change note when projects are added or removed by a successful sync.

## Rollout

1. Keep `config/projects.json` working for local development.
2. Add subscription settings and parser/validator tests.
3. Add SQLite lifecycle fields and sync behavior.
4. Wire the resolver into the collect stage.
5. Update report completeness to use the resolved active snapshot.
6. Document the external JSON format in `README.md` after implementation.

## Open Decisions Resolved

- Removed repositories should be marked inactive and excluded from future collection/report completeness, while historical data remains.
- The external source should use a JSON shape close to the current config, but `url` should be the only required identity field.
- The monitor should refresh the subscription at the start of each pipeline run.
- External subscription should be primary in production; local JSON remains as fallback only when no subscription URL is configured.
- The first run in subscription mode requires a reachable, valid subscription URL.
- Switching from subscription mode back to local mode does not automatically deactivate existing subscription-sourced rows in WHI-146.
