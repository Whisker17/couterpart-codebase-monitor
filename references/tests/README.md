# Impact-check test environment

Ground-truth cases for validating the impact-check service: each pairs an **upstream change**
with a **human-verified downstream Mantle adaptation commit**. The service should detect that the
upstream PR requires a Mantle adaptation when run against the pre-adaptation state.

Canonical data: [`impact-check-cases.json`](./impact-check-cases.json).

## Why pin a specific commit

A human judged "this upstream PR affects Mantle" against a **specific state** of the Mantle
codebase — the state *before* they made the adaptation. To reproduce that judgment faithfully we
must compare against that same commit, not the moving `mantle-elysium` tip.

For every adaptation commit `A`:

- **Positive test** — pin the downstream clone to `parent(A)` (pre-adaptation). The change is NOT
  yet present, so the service should report **`affected: yes`** ("adaptation needed").
- **Negative test** — pin to `A` itself (adaptation applied). The service should report
  **`affected: no`** ("already adapted").

This uses the **`--ref` flag** on `scripts/analyze-pr.ts` (implemented):

```bash
# positive (expect affected=yes)
bun run scripts/analyze-pr.ts <upstream-pr-url> \
  --target mantle-xyz/mantle-v2 --relationship depends_on \
  --ref 46803658bf7c4b2835f9ab8b2dbc1dfecff08f59

# negative (expect affected=no)
bun run scripts/analyze-pr.ts <upstream-pr-url> \
  --target mantle-xyz/mantle-v2 --relationship depends_on \
  --ref 0c77c603668d728a0b06af6b63ab54169bf4a448
```

`--ref` must fetch the specific commit onto the shallow clone (`git fetch --depth N origin <sha>` +
`git reset --hard <sha>`), since the default clone is `--depth 1 --single-branch`.

## The two cases (EIP-7843 SlotNumber)

Both adaptations are on `mantle-xyz/mantle-v2` @ `mantle-elysium`, in `op-service/sources/types.go`
(`RPCHeader` — Mantle's in-repo mirror of go-ethereum's `core/types.Header`). Because the mirror is
maintained in this repo (not pulled via the external op-geth `go.mod replace`), it **is** readable in
the mantle-v2 clone — making these solid *in-clone* positive tests.

| Case | Adaptation commit | Pre-adaptation pin (positive) | Upstream anchor |
|---|---|---|---|
| `eip7843-slotnumber-add` | `0c77c603` (2026-04-30) | `46803658` | go-ethereum#33589 — **CONFIRMED**: combined PR; its diff to `core/types/block.go` (+gen_header_rlp.go) adds `Header.SlotNumber`, which RPCHeader mirrors |
| `eip7843-slotnumber-omitempty` | `32f5a6ad` (2026-05-06) | `0c77c603` | go-ethereum#34704 — **CONFIRMED**: despite its title, its diff adds `,omitempty` to `SlotNumber` on engine `ExecutableData` (`beacon/engine/types.go`,`gen_ed.go`) — the upstream analogue of the RPCHeader fix |

Expected severity for both: **medium / digest**, not a critical push — these are feature-parity /
JSON-shape compatibility syncs (`rlp:"optional"`, `omitempty`, "ignored in legacy headers"), so a
missing field would not halt the chain. See the `impact-alert-severity-bar` memory.

## Status (2026-06-15, after the contract-drift fix landed)

- `--ref` is **implemented**; both upstream anchors are **confirmed** (see JSON `verified` fields).
- The contract-drift detector (`src/extensions/impact-checker/contract-drift.ts`) is implemented; fix
  design in [`docs/spark/2026-06-15-impact-check-contract-drift-detection.md`](../../docs/spark/2026-06-15-impact-check-contract-drift-detection.md).
- **Replay outcomes** (authoritative copy in the JSON `_validationResults_2026-06-15`):
  - **C1-positive → `affected=yes`** ✓ — the headline: RPCHeader detected MISSING SlotNumber (sibling
    overlap vs upstream `Header`), deterministic stale-mirror override forces yes with `contractCheck`
    code_evidence. Previously this was `uncertain`.
  - **C1-negative → `no`/`uncertain`** — RPCHeader correctly detected as SYNCED (no false positive);
    any residual uncertainty is the external-dependency (op-geth) consumer side, out of scope by design.
  - **C2-positive → `no` (expectation REVISED)** — the upstream change is on `ExecutableData`
    (payload/engine domain), which by the **domain guardrail** maps to a payload-domain mirror
    (`ExecutionPayload`), not header-domain `RPCHeader`. Mantle deliberately does not mirror slotNumber
    into `ExecutionPayload` (verified at tip), so there is no synced mirror to drift against. The
    original `yes` expectation contradicted the spec's own domain guardrail; this case is NOT detectable
    by domain-respecting structural mirror detection and is kept as a documented limitation.
  - **C2-negative → `no`** ✓.

### Optional follow-up

Add an EL-side pair from `mantle-xyz/reth` @ `mantle-elysium` (op-reth/revm SlotNumber/header adaptation,
e.g. around `776d5305` / `4b8234ea`) for a second target.
