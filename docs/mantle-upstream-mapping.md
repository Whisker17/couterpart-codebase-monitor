# Mantle Upstream Mapping

**Status**: Agent-researched runtime mapping; still requires Mantle code-owner confirmation before production alerting.
**Date**: 2026-06-13
**Runtime files**: `config/projects.json`, `config/mantle-config.json`
**Detailed topology source**: `references/outputs/mantle-topology-graph.json` and `references/outputs/mantle-upstream-topology-full.md`

This document summarizes the runtime mapping used by the monitor. The full research output is more precise than the runtime config: it models version-line nodes, subtree edges, copy-level nodes, and semantic constraints. The current application config is flatter, so it keeps the important source-to-target relationships in `config/mantle-config.json` and records version-line details in `reason` and `architectureNotes`.

## Runtime Coverage

`config/projects.json` is the report subscription and collection budget boundary. It currently tracks 6 reportable upstream repos:

- `ethereum/go-ethereum`
- `ethereum-optimism/optimism`
- `ethereum-optimism/op-geth`
- `paradigmxyz/reth`
- `bluealloy/revm`
- `succinctlabs/op-succinct`

This is deliberately smaller than the full topology. Adding Mantle internal repos or secondary external roots to `projects.json` expands the whole collect -> analyze -> report pipeline and should be treated as an explicit budget and product-scope decision, not as a side effect of impact-check mapping work.

**Live runtime config is scoped to the first batch (Milestone G).** `config/mantle-config.json` now activates only the `fork_of` relationships whose source is tracked, targeting the first-batch Mantle codebases — see "Active runtime subset" below. The **full source-to-target topology** (9 targets, 24 relationships, with all `reason`/`architectureNotes`) is preserved verbatim in `references/outputs/mantle-config.full.json` and is promoted into the live config incrementally as later phases land. Some relationship sources are not in `projects.json`; they stay deferred until impact-check source collection is intentionally enabled or decoupled from report subscriptions.

### Active runtime subset (first batch — Milestone G)

| Live target | Active upstream source | Relationship |
|---|---|---|
| `mantle-xyz/reth` | `ethereum-optimism/optimism` (via vendored `op-reth`) | `fork_of` |
| `mantle-xyz/mantle-v2` | `ethereum-optimism/optimism` | `fork_of` |

Everything else stays in `references/outputs/mantle-config.full.json` as **deferred, not deleted**: the other 7 targets, all `depends_on`/`protocol_dependency` edges, and untracked-source `fork_of` edges. `depends_on`/`protocol_dependency` wait for WHI-235; `mantle-v2`'s `alloy-rs/op-alloy` `fork_of` edge waits until that source is intentionally tracked. Promote an edge by copying it from the reference file into the live config and (if needed) adding its source to `projects.json`.

### Full topology (reference — preserved, not the live runtime set)

`references/outputs/mantle-config.full.json` defines 9 Mantle targets:

| Target | Branch | Why it is a target |
|---|---|---|
| `mantle-xyz/reth` | `mantle-elysium` | Composite op-reth workspace and Rust execution client. |
| `mantle-xyz/op-geth` | `main` | Go execution-client fork used by mantle-v2. |
| `mantle-xyz/mantle-v2` | `mantle-elysium` | OP Stack platform monorepo and Rust subtree provider for reth. |
| `mantle-xyz/kona` | `main` | Standalone derivation/fault-proof fork and op-succinct dependency. |
| `mantle-xyz/op-succinct` | `main` | SP1 validity proving stack. |
| `mantle-xyz/revm` | `mantle-elysium` | Mantle EVM/fee-model fork with the largest Rust-stack blast radius. |
| `mantle-xyz/op-alloy` | `main` | Standalone op-alloy 0.23.0 line for kona/op-succinct. |
| `mantle-xyz/evm` | `main` | EVM abstraction fork for kona/op-succinct. |
| `mantle-xyz/revm-inspectors` | `mantle-elysium` | Tracing inspector fork for reth. |

## Key Modeling Rules

- `ethereum-optimism/optimism`, not `paradigmxyz/reth@main`, is the bump driver for `mantle-xyz/reth`: Mantle vendors `rust/op-reth` and inherits the reth core rev selected by op-reth.
- `paradigmxyz/reth` has two separate version lines in the research topology: v2.2.0 for `mantle-xyz/reth`, and v1.6.0 for `mantle-xyz/kona` storage crates.
- `mantle-xyz/revm` has two active lines: `mantle-elysium` for reth/mantle-v2/revm-inspectors, and tag `v2.2.2` for kona/op-succinct.
- `op-alloy` exists as two divergent copies: standalone `mantle-xyz/op-alloy` for kona/op-succinct, and `mantle-v2/rust/op-alloy` for reth.
- `protocol_dependency` relationships in config are semantic consistency checks, not shared-code edges. They cover Mantle hardforks, fee semantics, `token_ratio`, BVM_ETH, MetaTransaction, DA/blob behavior, and cross-stack activation timing.

## Maintenance Notes

When editing the mapping:

1. Treat `config/projects.json` as the report subscription. Adding a repo there increases collection, analysis cost, daily reports, weekly candidates, and completeness counts.
2. Keep the full dependency topology in `config/mantle-config.json`. When `impactCheck.enabled=true`, every relationship source that should actually trigger checks must either be in the tracked project set or be supported by a separate impact-source collection path.
3. Keep `architectureNotes` populated for every target referenced by `protocol_dependency`; the checker uses those notes as its reasoning base.
4. Do not configure multiple relationships for the same `source -> target` pair. `impact_checks` is unique on `(pr_id, target_project_id)`, so the loader fails fast instead of silently choosing one relationship.
5. If multiple sources point at the same target with the same relationship type, preserve source-specific relationship reasons. The impact-check stage matches by `source + target + relationship`.
6. Re-run config validation and focused tests after any mapping change:
   - `jq empty config/projects.json config/mantle-config.json`
   - `bun test src/config/projects.test.ts src/extensions/impact-checker/index.test.ts src/pipeline/stages/impact-check.test.ts`

Open confirmation items:

- Confirm production status and relative priority of `mantle-xyz/reth` vs `mantle-xyz/op-geth`.
- Confirm whether `mantle-v2` should keep using `mantle-elysium` as the impact-check clone branch.
- Confirm whether tracking Mantle internal upstream repos should be enabled at the same cadence as external upstreams, separated into a lower-frequency job, or collected only for impact-check without entering counterpart reports.
