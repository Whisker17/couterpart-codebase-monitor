# Mantle ↔ Upstream Repo Mapping

**Status**: Agent-researched baseline — requires Mantle dev/code owner confirmation before production use.  
**Date**: 2026-06-13  
**Scope**: Mantle v2 (`mantle-xyz` org). Mantle v1 (`mantlenetworkio`) is legacy and not included (see §Excluded Repos).

---

## Summary

| Mantle target | Upstream source | Relationship | Confirmation |
|---|---|---|---|
| `mantle-xyz/reth` | `paradigmxyz/reth` | `fork_of` | Agent-researched |
| `mantle-xyz/op-geth` | `ethereum-optimism/op-geth` | `fork_of` | Agent-researched |
| `mantle-xyz/mantle-v2` | `ethereum-optimism/optimism` | `fork_of` | Agent-researched |
| `mantle-xyz/op-geth` | `ethereum/go-ethereum` | `depends_on` | Agent-researched |
| `mantle-xyz/mantle-v2` | `ethereum/go-ethereum` | `depends_on` | Agent-researched |
| `mantle-xyz/op-succinct` | `succinctlabs/op-succinct` | `fork_of` | Agent-researched |
| `mantle-xyz/kona` | `op-rs/kona` | `fork_of` | Agent-researched |

---

## Mantle Target Repos

### `mantle-xyz/reth`
- **URL**: https://github.com/mantle-xyz/reth
- **Language**: Rust
- **Default branch**: `main`
- **GitHub fork status**: `isFork=true`, `parent=paradigmxyz/reth`
- **Description**: Mantle's Rust-based L2 execution client.

### `mantle-xyz/op-geth`
- **URL**: https://github.com/mantle-xyz/op-geth
- **Language**: Go
- **Default branch**: `main`
- **GitHub fork status**: `isFork=true`, `parent=ethereum-optimism/op-geth`
- **Description**: Mantle's Go execution client (OP Stack flavour, used in v2 stack).

### `mantle-xyz/mantle-v2`
- **URL**: https://github.com/mantle-xyz/mantle-v2
- **Language**: Go
- **Default branch**: `main`
- **GitHub fork status**: `isFork=false` (detached fork — not marked on GitHub but confirmed via module path)
- **Description**: Mantle v2 protocol monorepo — op-node, op-batcher, op-proposer, op-challenger, alt-DA, and related OP Stack components.

### `mantle-xyz/kona`
- **URL**: https://github.com/mantle-xyz/kona
- **Language**: Rust
- **Default branch**: `main`
- **GitHub fork status**: `isFork=true`, `parent=op-rs/kona`
- **Description**: Rust OP Stack derivation and fault proof programs (no_std, FPVM/ZK compatible).

### `mantle-xyz/op-succinct`
- **URL**: https://github.com/mantle-xyz/op-succinct
- **Language**: Rust
- **Default branch**: `main`
- **GitHub fork status**: `isFork=true`, `parent=succinctlabs/op-succinct`
- **Description**: ZK proving for Mantle's OP Stack rollup using SP1.

---

## Relationship Evidence

### 1. `paradigmxyz/reth` → `mantle-xyz/reth` (`fork_of`)

**Evidence type**: `fork_remote` + `cargo_workspace`

- GitHub API (`GET /repos/mantle-xyz/reth`): `"fork": true`, `"parent": { "full_name": "paradigmxyz/reth" }`
- `Cargo.toml` (workspace root): `repository = "https://github.com/paradigmxyz/reth"`, `authors = ["Mantle Core Contributors"]`
- Workspace members identical to paradigmxyz/reth structure (crates/engine, crates/chainspec, bin/reth, etc.)

**Rationale**: The upstream reth codebase defines the engine API, block execution pipeline, EVM integration (revm), and storage model. Any breaking change in these surfaces — new engine API method, changed block header format, EVM hardfork activation — requires rebasing mantle-xyz/reth and verifying Mantle-specific patches (MNT gas, DA layer) still apply cleanly.

**Needs Mantle eng confirmation**: Which reth patches are Mantle-specific vs. upstream-compatible? Which crates are most heavily modified?

---

### 2. `ethereum-optimism/op-geth` → `mantle-xyz/op-geth` (`fork_of`)

**Evidence type**: `fork_remote` + `go_module`

- GitHub API (`GET /repos/mantle-xyz/op-geth`): `"fork": true`, `"parent": { "full_name": "ethereum-optimism/op-geth" }`
- `go.mod` (mantle-xyz/op-geth root): `module github.com/ethereum/go-ethereum` — op-geth retains go-ethereum's module path as part of its own fork-of-a-fork lineage

**Rationale**: op-geth is Mantle's Go execution client for the OP Stack. Upstream op-geth releases track new Ethereum hardforks (EIP activations), EVM changes, and OP Stack protocol updates. Changes to the OP `miner`, `eth/catalyst` engine API, or transaction validation in op-geth must be rebased into mantle-xyz/op-geth.

**Needs Mantle eng confirmation**: Is mantle-xyz/op-geth still the primary execution client, or is it being superseded by mantle-xyz/reth? Are both maintained in parallel?

---

### 3. `ethereum-optimism/optimism` → `mantle-xyz/mantle-v2` (`fork_of`)

**Evidence type**: `go_module` + `directory_structure`

- `go.mod` (mantle-xyz/mantle-v2 root, SHA `31327bec`): `module github.com/ethereum-optimism/optimism` — module path retained from upstream
- Root directory structure (via GitHub API `GET /repos/mantle-xyz/mantle-v2/contents`): `op-node`, `op-batcher`, `op-proposer`, `op-challenger`, `op-dispute-mon`, `op-program`, `cannon`, `op-alt-da`, `op-interop-mon`, `op-conductor`, `op-deployer`, `op-supervisor`, `kona` — identical to the optimism monorepo layout
- GitHub API `"fork": false` — the fork relationship is not reflected in GitHub metadata (possibly due to significant divergence or repo creation method), but module path and directory tree confirm the upstream lineage

**Rationale**: mantle-v2 contains all OP Stack protocol-layer components. Changes to OP Stack's derivation pipeline (op-node), sequencer, fault proof system (op-challenger, cannon, op-program), dispute game contracts, or interop must be tracked and merged/rebased into mantle-v2. This is the highest-impact relationship in the entire mapping.

**Needs Mantle eng confirmation**: Which OP Stack components are most heavily patched? Is there a systematic rebase cadence vs. upstream releases? The `kona` directory inside mantle-v2 — is this a vendored/embedded copy or a submodule pointer to mantle-xyz/kona?

---

### 4. `ethereum/go-ethereum` → `mantle-xyz/op-geth`, `mantle-xyz/mantle-v2` (`depends_on`)

**Evidence type**: `go_module` + `replace_override`

- `go.mod` (mantle-xyz/op-geth): `module github.com/ethereum/go-ethereum` — op-geth IS go-ethereum with OP Stack patches; go-ethereum changes propagate transitively through the fork chain (go-ethereum → op-geth → mantle-xyz/op-geth)
- `go.mod` (mantle-xyz/mantle-v2, SHA `31327bec`): direct `require github.com/ethereum/go-ethereum v1.16.5` with `replace github.com/ethereum/go-ethereum => github.com/mantlenetworkio/op-geth v1.5.4` — replace directive pins mantle-xyz/mantle-v2 to their custom op-geth fork, but the import paths and API surface are go-ethereum's

**Rationale**: L1 Ethereum hardfork changes (new opcodes, block header field additions, blob format changes, precompile updates) appear first in go-ethereum and then propagate into op-geth and the OP Stack monorepo. Monitoring go-ethereum PRs — especially EIP implementations and consensus changes — provides early warning for Mantle's execution and derivation layers.

**Needs Mantle eng confirmation**: The replace directive in mantle-v2 pins to `mantlenetworkio/op-geth v1.5.4` (v1 legacy op-geth), not `mantle-xyz/op-geth`. Is this intentional? Is mantle-v2 being migrated to use `mantle-xyz/op-geth` instead?

---

### 5. `succinctlabs/op-succinct` → `mantle-xyz/op-succinct` (`fork_of`)

**Evidence type**: `fork_remote`

- GitHub API (`GET /repos/mantle-xyz/op-succinct`): `"fork": true`, `"parent": { "full_name": "succinctlabs/op-succinct" }`
- Description: "OP Succinct turns any OP stack rollup into a full type-1 zkEVM Rollup in 1 hour using SP1." — description inherited from upstream

**Rationale**: op-succinct provides the ZK proof wrapper for Mantle's OP Stack chain using Succinct's SP1 prover. Upstream changes to SP1 integration, proof aggregation contracts, OP Stack derivation compatibility, or proof verification logic in succinctlabs/op-succinct must be tracked and rebased into mantle-xyz/op-succinct.

**Needs Mantle eng confirmation**: What is the cadence for syncing with upstream op-succinct? Are there significant Mantle-specific patches (e.g., custom DA, MNT gas), or is this closer to a thin configuration fork?

---

### 6. `op-rs/kona` → `mantle-xyz/kona` (`fork_of`)

**Evidence type**: `fork_remote`

- GitHub API (`GET /repos/mantle-xyz/kona`): `"fork": true`, `"parent": { "full_name": "op-rs/kona" }`
- Description: "A suite of `no_std` components for the OP Stack state transition function and L2 chain derivation."

**Rationale**: kona implements the OP Stack state transition function in Rust for use in fault proof programs and ZK circuits. Upstream changes to derivation logic, preimage oracle interface, or FPVM integration in op-rs/kona affect Mantle's proof infrastructure. This is closely coupled to mantle-xyz/op-succinct (kona is the derivation backend for ZK proofs).

**Needs Mantle eng confirmation**: Is mantle-xyz/kona also used as the derivation backend for mantle-xyz/mantle-v2's fault proofs (via cannon/op-program), or is it used exclusively by mantle-xyz/op-succinct?

---

## Currently Tracked Upstreams — Coverage Assessment

| Tracked upstream | Has counterpart relationship | Notes |
|---|---|---|
| `ethereum/go-ethereum` | Yes — `depends_on` → `mantle-xyz/op-geth`, `mantle-xyz/mantle-v2` | Transitive via fork chain and go.mod replace |
| `ethereum-optimism/optimism` | Yes — `fork_of` → `mantle-xyz/mantle-v2` | Highest-impact upstream for Mantle v2 |
| `succinctlabs/op-succinct` | Yes — `fork_of` → `mantle-xyz/op-succinct` | Direct fork |

All three previously-tracked upstreams now have valid relationships. None are "not applicable."

---

## Newly Added Upstreams

| New upstream | Relationship | Mantle targets |
|---|---|---|
| `paradigmxyz/reth` | `fork_of` | `mantle-xyz/reth` |
| `ethereum-optimism/op-geth` | `fork_of` | `mantle-xyz/op-geth` |
| `op-rs/kona` | `fork_of` | `mantle-xyz/kona` |

---

## Excluded Repos

### `mantlenetworkio/mantle` (Mantle v1 — legacy)
- **Excluded**: Yes
- **Reason**: This is the v1 monorepo (`module github.com/ethereum-optimism/optimism` in go.mod, also a fork of the optimism stack). Active development has migrated to `mantle-xyz/mantle-v2`. Including the v1 repo would produce duplicate signals for the same protocol surface. Mantle eng should confirm whether v1 is still maintained and receiving security fixes.

### `mantlenetworkio/erigon`, `mantlenetworkio/datalayr`, etc.
- **Excluded**: Yes — these are archived or peripheral repos not related to the active L2 execution/proof stack.

### `mantle-xyz/revm`, `mantle-xyz/evm`, `mantle-xyz/revm-inspectors`
- **Excluded** from explicit tracking — these Rust EVM forks are likely transitive dependencies pulled in by `mantle-xyz/reth` (reth uses revm as its EVM). Changes in these repos are already covered by monitoring `paradigmxyz/reth` (which pins revm versions). Add as separate targets only if Mantle carries significant local patches to revm itself.

### `mantle-xyz/op-rbuilder`
- **Excluded** for now — op-rbuilder is a builder/block-construction tool, not a core protocol component. Can be added if Mantle eng identifies it as security-relevant.

---

## Maintenance Notes

1. **This is an agent-researched baseline.** The relationships above are derived from GitHub API metadata (fork/parent fields), manifest files (go.mod, Cargo.toml), and directory structure inspection. They have NOT been confirmed by Mantle developers or code owners.

2. **Relationship types may need refinement.** The `depends_on` classification for `ethereum/go-ethereum` is technically a transitive fork-chain dependency rather than a direct module import (for `mantle-xyz/op-geth`). Mantle eng may prefer to classify it as `fork_of` if they consider go-ethereum the canonical ancestor.

3. **Version pins are volatile.** The replace directive `github.com/ethereum/go-ethereum => github.com/mantlenetworkio/op-geth v1.5.4` in mantle-v2's go.mod should be reviewed — this pins to a specific version of the legacy v1 op-geth, not the newer `mantle-xyz/op-geth`. This may indicate a pending migration or a deliberate separation between v1 infra and v2 protocol.

4. **WHI-232 calibration dependency.** The candidate counts and impact check budget estimates in WHI-232 are directly affected by this mapping. After Mantle eng confirms or adjusts the target list and relationships, WHI-232 should be re-run to revalidate the distribution.

5. **Updating this mapping**: Any addition/removal of Mantle targets or changes to relationship types should:
   - Update `config/mantle-config.json` and `config/projects.json`
   - Record the evidence and rationale in this doc under a new dated section
   - Re-run WHI-232 calibration or equivalent
   - Note the `config_hash` change will affect impact check upsert semantics

6. **Confirmation checklist for Mantle eng**:
   - [ ] Confirm `mantle-xyz/reth` is the production execution client (or confirm dual-client status with `mantle-xyz/op-geth`)
   - [ ] Confirm `mantle-xyz/mantle-v2` is the active v2 monorepo replacing `mantlenetworkio/mantle`
   - [ ] Clarify the replace directive in mantle-v2: `mantlenetworkio/op-geth v1.5.4` vs. `mantle-xyz/op-geth`
   - [ ] Clarify whether the `kona` directory inside mantle-v2 is vendored or a submodule pointer to `mantle-xyz/kona`
   - [ ] Confirm `mantle-xyz/op-succinct` and `mantle-xyz/kona` are production components vs. experimental
   - [ ] Identify any additional Mantle repos with significant protocol-surface code not listed here
