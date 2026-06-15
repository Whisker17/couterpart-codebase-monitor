# WHI-238 Phase 1 Impact Checker Baseline

Date: 2026-06-14

Scope: fork_of-only Mantle Impact Checker Phase 1 readiness check.

## Local Verification

Commands run:

- `bun test`: 691 pass, 0 fail.
- `bun x tsc --noEmit`: pass.
- `bun run scripts/impact-check-backtest.ts`: pass.
- `bun run cli -- --json db status`: pass.
- `bun run cli -- --json config show impact-check`: pass.
- `bun run cli -- --json config show unknown`: expected non-zero exit with invalid-section error.
- `bun run cli -- budget --month 2026-06`: pass.
- `bun run cli -- impact-check requeue --skipped-budget`: dry-run pass.
- Concurrent CLI smoke (`impact-check requeue --skipped-budget` and `budget --month 2026-06`): pass after moving `PRAGMA busy_timeout=5000` before WAL initialization.

Copied-DB smoke runs:

- Source DB: `data/monitor.db`, copied into an isolated temporary directory.
- Runtime config override: `impactCheck.enabled=true`, `maxChecksPerDay=1`, `dispatchEnabled=false`, isolated `clonesDir`.
- Result: 78 candidate rows upserted, 1 check completed, 77 skipped by daily quota, 0 clone failures, 0 alert dispatch attempts.
- Completed sample: `ethereum-optimism/optimism#21314` against `mantle-xyz/reth`, status `complete`, `affected=uncertain`, `confidence=low`, `evidence_kind=reasoning_based`, `target_commit` recorded.
- Audit: JSONL trace was written and included real repository tool calls plus a structured final verdict.

Additional copied-DB batch with production default `maxStepsPerCheck=12`:

| Check | Source PR | Target | Verdict | Evidence | Cost | Steps | Dispatch |
| ---: | --- | --- | --- | --- | ---: | ---: | --- |
| 7043 | `ethereum-optimism/optimism#21314` | `mantle-xyz/reth` | `uncertain` / `medium` before truncation fix | `code_evidence` | `$0.195918` | 12 | no alert |
| 7044 | `ethereum-optimism/optimism#21314` | `mantle-xyz/mantle-v2` | `yes` / `high` | `code_evidence` | `$0.230478` | 11 | card stored, not sent |
| 7065 | `ethereum-optimism/optimism#21283` | `mantle-xyz/reth` | `no` / `high` | `code_evidence` | `$0.141381` | 10 | no alert |

Post-fix single-check rerun:

- `ethereum-optimism/optimism#21314` against `mantle-xyz/reth` now returns `affected=uncertain`, `confidence=low`, `evidence_kind=reasoning_based`, `tool_steps=12`, `alert_attempt_count=0`.
- This confirms step-limit truncation no longer leaves medium confidence.

20-check copied-DB dry-run:

- Source DB: `data/monitor.db`, copied into `/tmp/whi238-batch10.sVh1e0/monitor.db`.
- Runtime config override: `impactCheck.enabled=true`, `maxChecksPerDay=20`, `maxStepsPerCheck=12`, `dispatchEnabled=false`, isolated `clonesDir`.
- Result: 20 checks completed, 58 remained pending due quota, 0 clone failures, 0 dispatched alerts, 0 dead-lettered alerts.
- Cost in the copied DB: `$2.845869` total, about `$0.1423/check`.
- Coverage: `affected=yes/no/uncertain` all represented.

20-check verdict distribution:

| Verdict | Evidence | Count | Cost | Cards stored | Alert attempts |
| --- | --- | ---: | ---: | ---: | ---: |
| `no` / `high` | `code_evidence` | 8 | `$1.032657` | 0 | 0 |
| `no` / `medium` | `manifest_evidence` | 1 | `$0.085512` | 0 | 0 |
| `no` / `low` | `code_evidence` | 1 | `$0.111180` | 0 | 0 |
| `uncertain` / `low` | `code_evidence` | 8 | `$1.283604` | 0 | 0 |
| `yes` / `high` | `code_evidence` | 2 | `$0.332916` | 2 | 0 |

Programmatic evidence checks over the 20 rows:

- All 20 complete rows recorded `target_commit`.
- All 20 complete rows had at least one evidence entry.
- No complete row had an empty evidence `file` or empty evidence `snippet`.
- All rows with `tool_steps >= 12` were `affected=uncertain`, `confidence=low`.

Targeted post-fix replay:

- The 20-check batch exposed one false-positive alert candidate: `9076` (`ethereum-optimism/optimism#21295` against `mantle-xyz/mantle-v2`) was `yes/high` before the no-action guard, but its own recommendation said not to cherry-pick because Mantle correctly defaults to `engine.Geth`.
- Current-code unit coverage now demotes explicit no-action verdicts below the alert threshold while preserving high confidence for real manual-port actions.
- A current-code targeted replay of `9076` produced `affected=uncertain`, `confidence=low`, `evidence_kind=code_evidence`, `tool_steps=5`, `evidenceVerificationFailed=false`, no alert. The replay hit one transient `Bad Gateway` during the agent loop and fell back conservatively.

Current-build 20-check copied-DB dry-run:

- Source DB: `data/monitor.db`, copied into `/tmp/whi238-current20.kUqzm5/monitor.db`.
- Runtime config override: `impactCheck.enabled=true`, `maxChecksPerDay=20`, `maxStepsPerCheck=12`, `dispatchEnabled=false`, isolated `clonesDir`.
- Result: 20 checks completed, 58 remained pending due quota, 0 clone failures, 0 dispatched alerts, 0 dead-lettered alerts.
- Cost in the copied DB: `$2.934108` total, about `$0.1467/check`.
- Coverage: `affected=yes/no/uncertain` all represented.
- `--no-dispatch` stored 1 alert card and left `alert_attempt_count=0`.

Current-build 20-check verdict distribution:

| Verdict | Evidence | Count | Cost | Cards stored | Alert attempts |
| --- | --- | ---: | ---: | ---: | ---: |
| `no` / `high` | `code_evidence` | 10 | `$1.221297` | 0 | 0 |
| `no` / `medium` | `code_evidence` | 1 | `$0.100701` | 0 | 0 |
| `uncertain` / `low` | `code_evidence` | 8 | `$1.396797` | 0 | 0 |
| `yes` / `high` | `code_evidence` | 1 | `$0.215313` | 1 | 0 |

Current-build evidence checks over the 20 rows:

- All 20 complete rows recorded `target_commit`.
- All 20 complete rows had at least one evidence entry.
- No complete row had an empty evidence `file` or empty evidence `snippet`.
- All rows with `tool_steps >= 12` were `affected=uncertain`, `confidence=low`.
- One row (`41`) triggered `evidence_verification_failed` for a non-real snippet note; it was demoted to `uncertain/low` and did not render an alert card.

## Calibration Result

Backtest window: last 30 days, timezone Asia/Shanghai.

| Date | Candidates | Previous quota | Calibrated quota |
| --- | ---: | ---: | ---: |
| 2026-06-10 | 40 | 5 | 40 |
| 2026-06-12 | 38 | 5 | 40 |

Significance distribution:

| Significance | Candidates |
| --- | ---: |
| directional_shift | 16 |
| notable | 62 |
| routine | 0 |
| null | 0 |

Decision: set `impactCheck.maxChecksPerDay` to `40`. The previous value `5` would have left both candidate days over quota and was not suitable for the WHI-238 no-long-term-pending criterion.

`monthlySubCap` remains `$50`. The observed 78 candidate checks fit the Phase 1 cost model from WHI-229 (`$0.10-$0.50/check`, about `$7.80-$39.00` for this window), while `maxCostPerCheck=$1.00` remains the per-check hard guard.

## A/B/C Readiness Status

### A. Functional Correctness

Local automated verification is green:

- Impact Checker is wired after Analyzer and before Report Generator.
- Impact Checker stage failures do not stop later report/dispatch stages.
- `--no-dispatch` suppresses alert sends without consuming alert retry budget.
- Alert cards are generated only for `affected=yes` and `confidence=high`.
- Evidence verification demotes hallucinated `code_evidence`.
- Clone timeouts and disk guardrails degrade without aborting the full stage.
- `db status` exposes `impact_checks` counts and dead-letter alert count.

### B. Evidence Quality

Partial pass. Copied-DB smoke/batch runs completed real Impact Checker evaluations and produced grounded audit traces.

During the first copied-DB dry-run, the agent tool trace contained real repository searches, but the structured verdict synthesis step did not receive the investigation transcript or tool trace. That made the final JSON verdict capable of contradicting the actual trace. The checker now passes both the investigation text and compact tool trace into the structured verdict prompt, covered by a regression test.

During the 3-check batch, one negative `code_evidence` verdict contained an empty evidence entry used as a prose note for negative grep results. This loosened the meaning of `code_evidence`. The checker now treats empty evidence arrays, empty file paths, and empty snippets as evidence verification failures and lowers confidence to `low`, covered by regression tests.

The same batch also showed that step-limit truncation could leave a verdict at `confidence=medium`. The checker now forces truncated checks to `affected=uncertain` and `confidence=low`, matching the conservative Phase 1 prompt contract and covered by a regression test.

The 20-check batch exposed a high-confidence false positive where the target was relevant but the correct recommendation was to intentionally keep the fork behavior unchanged. The checker now prevents explicit no-action recommendations from crossing the alert threshold, while preserving high confidence when the recommendation is to manually port a fix.

Manual spot-check notes:

- `7044` (`affected=yes`, `confidence=high`) cites existing files and snippets in `mantle-xyz/mantle-v2`:
  - `op-service/txinclude/isthmus_cost_oracle.go` uses `operatorCost.Div(operatorCost, oneMillion)`.
  - `op-service/txinclude/txbudget.go` contains `TODO(17817)` and divides operator cost by `oneMillion`.
  - `op-service/txinclude/isthmus_cost_oracle_test.go` expects the old Isthmus result `10`.
- `7065` (`affected=no`, `confidence=high`) cites `Cargo.toml` showing the Rust workspace shape; tool trace also records negative greps for the upstream Go `op-interop-mon` components.
- `9044` (`affected=yes`, `confidence=high`) is a true positive: it cites `op-service/txinclude/isthmus_cost_oracle.go` and `op-service/txinclude/txbudget.go` using the old `oneMillion` operator-cost formula and an explicit `TODO(17817)`.
- `9076` was a false positive before the no-action guard: code evidence was real, but the recommended action was to avoid adopting the upstream default because Mantle still uses `op-geth`. Current code no longer lets that pattern produce a high-confidence alert.

The copied-DB sample-size gate is now locally exercised on the current build: 20 completed checks cover `affected=yes/no/uncertain`, and the checked evidence fields are non-empty. The single high-confidence alert candidate (`44`) is a true positive for the operator-fee bug; the prior no-action false positive (`9076`) is now classified as `no/high` and does not render a card. Because this was copied-DB local dry-run evidence rather than a deployed production observation window, it is sufficient as a local Phase 1 quality baseline but not sufficient to close WHI-238.

### C. Cost And Stability

Partial pass:

- June 2026 current tracked cost is `$5.170557` against the `$150` monthly cap.
- Backtest-derived candidate volume fits the unchanged `$50` impact-check sub-cap.
- No current local `impact_checks` backlog exists.
- Copied-DB smoke/batch runs used `--no-dispatch` semantics and did not consume alert retry budget (`alert_attempt_count=0` for the stored high-confidence card).
- The 3-check batch cost was `$0.565777` total, roughly `$0.1886/check`, within the Phase 1 cost model and below the `$1.00` per-check guard.
- The 20-check copied-DB dry-run cost was `$2.845869` total, roughly `$0.1423/check`, with 0 clone failures, 0 alert send attempts, and 0 dead-lettered alerts.
- The targeted 9076 replay added `$0.129249` of LLM cost and fell back safely after a transient `Bad Gateway`.
- The current-build 20-check copied-DB dry-run cost was `$2.934108` total, roughly `$0.1467/check`, with 0 clone failures, 0 alert send attempts, and 0 dead-lettered alerts.
- SQLite startup now applies `busy_timeout` before switching to WAL. This avoids a fast `database is locked` failure when an ops CLI command starts concurrently with another monitor command or shutdown checkpoint.

No go yet for the 5-7 day production stability requirement. The local database currently has zero `impact_checks` rows, so it cannot prove sustained absence of crashes, dead-letter buildup, or pending accumulation.

## Go/No-Go

Current conclusion: no-go for marking WHI-238 complete.

Reason: Phase 1 implementation is locally green, the operational quota has been calibrated, and a current-build copied-DB 20-check dry-run now completes without dispatching alerts. The local dry-runs exposed and fixed four Phase 1 quality issues: structured verdict context was missing tool evidence, evidence verification allowed empty `code_evidence`, truncation could retain non-low confidence, and explicit no-action recommendations could still cross the high-confidence alert threshold. WHI-238 completion still requires deployment, a production `--no-dispatch` precision sample, and 5-7 days of production observation. Those data do not exist in the current local database.

Next production gate:

1. Deploy the current main revision and confirm `deploy.sh` health check passes.
2. Run one full `--no-dispatch` pipeline with `impactCheck.enabled=true` on production data.
3. Inspect `impact_checks` rows and `data/impact-checks/{id}.jsonl`.
4. Manually review at least 20 completed checks from the current build and record precision.
5. If quality is acceptable, keep `enabled=true`, restore dispatch, and observe 5-7 days.
