# Fix spec: impact-check misses "contract mirror drift"

Status: draft for review
Date: 2026-06-15
Area: `src/extensions/impact-checker` (checker prompt + strategies)
Trigger: validation against `references/tests/impact-check-cases.json` (EIP-7843 SlotNumber)

---

## 1. Problem

The impact-check service is meant to answer: *"does this upstream PR require the downstream
Mantle codebase to adapt?"* It currently **fails to detect a whole class of real adaptations** —
specifically when Mantle keeps its **own local copy of an upstream contract** (a mirror struct,
re-declared wire type, re-implemented interface, copied enum/constant) that must be hand-synced
when upstream changes.

### Observed failure (ground-truth validation)

Two human-made Mantle adaptations were replayed by pinning the downstream clone to the commit
*before* each adaptation (so the system *should* report "adaptation needed = affected: yes"):

| Case | Upstream PR | Downstream pin (pre-adaptation) | Expected | Actual |
|---|---|---|---|---|
| C1 add `RPCHeader.SlotNumber` | go-ethereum#33589 (adds `core/types.Header.SlotNumber`) | `46803658` (RPCHeader lacks the field) | **affected: yes** | **uncertain / low** |
| C2 add `,omitempty` to `RPCHeader.SlotNumber` | go-ethereum#34704 (adds `,omitempty` to engine `ExecutableData.SlotNumber`) | `0c77c603` (RPCHeader tag lacks `,omitempty`) | **affected: yes** | **no** |

(Negative controls — pinning *after* each adaptation — behaved acceptably: C1 `uncertain`-leaning-no,
C2 clean `no`. So the system is not "always yes"; it is failing to fire on true positives.)

The downstream artifact in both cases is `op-service/sources/types.go` → `RPCHeader`, a hand-maintained
mirror of go-ethereum's `core/types.Header`. At the pre-adaptation pin the mirror genuinely lacks the
field/tag the upstream PR introduced — a real, detectable gap — yet the system did not flag it.

---

## 2. Why this happens (root cause)

The `depends_on` strategy models the target as a **pure consumer** of the upstream via a package
manifest. Its reasoning chain is: *find how the target consumes the changed component (Cargo.lock /
go.mod), resolve the version boundary, decide if the change is in scope.* For `go-ethereum → mantle-v2`
that boundary is the `go.mod replace` to `mantlenetworkio/op-geth` — **an external repo not in the
clone**. So the agent reaches the boundary, cannot read op-geth's source, observes the change is an
"additive optional field" and concludes it flows through transparently and is backward-compatible →
`uncertain`/`no`. Verbatim from the C1-positive run:

> "Zero references to SlotNumber … exist in this repo's own code … without access to the Mantle op-geth
> fork's source, we cannot definitively confirm … The structural additions are additive optional
> pointer fields and should be backward-compatible even if present."

The model has **no concept that Mantle also *re-declares* upstream contracts locally** and must sync
them. It never asks *"does the target's own copy of this contract include the change?"* — so a missing
mirror field reads as "not referenced here → not our concern" instead of "mirror is out of date → adapt".

In C2 the agent actually *saw* the gap ("RPCHeader.SlotNumber lacks omitempty") but dismissed it as a
different struct from the PR's `ExecutableData`, so "not this PR's concern." That is a defensible
literal reading, but it still misses the adaptation a human made.

### Why the per-target knowledge fix (option 1) is rejected

Adding "RPCHeader mirrors core/types.Header" to that target's `architectureNotes` would fix these two
cases but is a brittle, non-generalizing trick: it hard-codes one file/struct pair, must be hand-written
for every mirror in every target, and silently fails for mirrors nobody documented. The detection should
be a **general capability**, not a per-target hint.

---

## 3. Proposed solution: contract-delta mirror check

Reframe the question the checker asks. Today: *"is the changed upstream code reachable in the target?"*
Add: *"does the target keep its own copy of any contract this PR changed, and is that copy now stale?"*

This generalizes because it keys off **identifiers and contract shape**, not off any specific file:
any downstream that re-declares an upstream contract (mirror struct, wire/JSON type, enum, interface,
constant set, API method list) will surface its drift by the same mechanism — no per-target config.

### Mechanism (new strategy phase, runs regardless of dependency boundary)

> **Critical correctness note (review fix):** mirror discovery must NOT key off the *new* identifier.
> In the true-positive case the local mirror is stale precisely *because the new field is absent*, so
> grepping the new identifier (`SlotNumber`) returns nothing and the check would fall back to the old
> consumer model and miss again. Discovery must key off the **enclosing contract + its sibling
> members** (the parts that already exist on both sides), and only *then* test the new member for
> presence/absence.

**Step A — Extract the contract delta from the upstream diff.** For each changed definition, capture
the *enclosing contract* and the *delta*, not just the new identifier:
- `enclosingContract`: the struct/type/enum/interface name being modified (e.g. `Header`,
  `ExecutableData`) plus its language and file.
- `siblingMembers`: the other fields/variants/tags that already exist on that contract (the stable
  anchors used to locate a mirror).
- `delta`: the added/changed member — field name + type + serialization tag(s) (e.g.
  `SlotNumber *uint64 json:"slotNumber" rlp:"optional"`), or `tag-change` (e.g. `json:"slotNumber"` →
  `json:"slotNumber,omitempty"`), or enum variant / signature / constant.
- `serializedKey` + `semanticDomain`: the wire key (`slotNumber`) and protocol domain
  (Header / Payload / Engine-API / consensus / config) — used for cross-struct matching (see C2).

**Step B — Locate the local mirror via SIBLING OVERLAP (not the new identifier).** Search the target
clone for a local definition whose members overlap the upstream `siblingMembers` (e.g. a struct that
also has `ParentHash`, `StateRoot`, … → it mirrors `Header`) — independent of whether the new member is
there yet.

**v1 match rule (not an open question):** a candidate counts as a mirror only if it meets
**≥2 sibling-member overlaps** (by identifier or serialized key) **OR** an explicit
architecture-notes path tying it to that contract/domain. A single shared name is NOT enough — a lone
`slotNumber` in, say, a metrics struct fails this rule and is rejected. (This threshold is the v1
default; tune only against the false-positive fixture below.)

**Step C — Test the delta against the mirror, then decide.**
- Mirror found **and** it already contains the delta (field present / tag matches) → `affected: no`
  (already synced). Evidence: the mirror member.
- Mirror found **but** the delta is absent or divergent (field missing / tag lacks `,omitempty`) →
  **`affected: yes`** (adaptation needed). Evidence: the **full enclosing mirror definition** showing
  the gap (see Evidence rules). Fires *even when the upstream source is in an unreadable external dep*,
  because the proof is the target's own stale copy.
- No local mirror found (siblings don't overlap anything) → fall back to the existing
  dependency-boundary (consumer) reasoning.

This is additive: the consumer phase stays for genuine consume-only cases; the mirror phase adds the
missing "re-implementer" lens and reaches a confident verdict where the consumer phase stalls at
`uncertain`.

### Cross-struct contract matching — and the C2 correction

**Decision:** cross-struct matching is allowed, but a match requires **all** of:
1. sibling-field overlap (≥2) with the changed contract, AND
2. **same `semanticDomain`** (header / payload / engine-api / consensus / config) — enforced in code
   (`findLocalContractMirrors`), AND
3. (corroboration) an architecture-notes path may substitute for a weak overlap.

A bare identifier collision (e.g. an unrelated `slotNumber` in a metrics struct) fails (1)/(2).

> **C2 correction (decided during implementation — supersedes the earlier "C2-positive = yes").**
> C2's upstream change is on `beacon/engine.ExecutableData.SlotNumber` (payload/engine domain). The
> domain guardrail (2) maps a payload-domain change to a payload-domain mirror — in this repo
> `op-service.ExecutionPayload` — NOT to the header-domain `op-service.RPCHeader`. Verified at the
> `mantle-elysium` tip: Mantle deliberately mirrors `slotNumber` ONLY in `RPCHeader`, never in
> `ExecutionPayload`. So #34704 has no synced, same-domain downstream mirror to drift against →
> **C2-positive correctly resolves to `affected: no`**. The human's `RPCHeader` `,omitempty` tweak was a
> parallel header-domain decision that a domain-respecting structural detector neither can nor should
> attribute to a payload-domain PR. **C2 is therefore a documented NEGATIVE/limitation case, not a
> positive.** (The original "C2-positive = yes" contradicted guardrail (2) and is withdrawn.)

### Verdict definition change (must update `prompts/impact-check/fork.md`)

`fork.md`'s `affected: "yes"` is currently defined as "the fork contains the same bug/vulnerability/
breaking behavior" — a *presence-of-bad-code* framing that does NOT cover "local contract copy is
**missing** an upstream addition". The implementation must extend the verdict definitions + output rules
so `affected: "yes"` explicitly includes: **"the target maintains a local copy of an upstream contract
and that copy is now stale/divergent (missing a field, an enum variant, a tag, a method) and needs a
code adaptation."** Without this, the global prompt pulls the agent back to the bug-presence framing and
the strategy change is undermined.

### Schema change (required — prose JSON is not enough)

`generateObject` enforces `VerdictSchema` (`checker.ts:40`); any structured result the agent "also
prints" in prose is **dropped** and never reaches `verifyEvidence`, storage, or the card. So the
structured mirror result must be a **first-class schema field**, not free text.

Recommended: extend each `evidence[]` item with optional contract-drift fields (keeps it in the existing
`evidence` JSON column — **no migration**, audit already logs the full verdict, card just reads the new
optional fields):

```ts
evidence: z.array(z.object({
  file: z.string(), lines: z.string(), snippet: z.string(), note: z.string(),
  // contract-drift (optional; present only for mirror-check evidence):
  contractCheck: z.object({
    mirror: z.string(),                 // e.g. "RPCHeader"
    member: z.string(),                 // e.g. "SlotNumber"
    serializedKey: z.string().nullable(),  // e.g. "slotNumber"
    expectedTag: z.string().nullable(),    // upstream's tag, e.g. "json:\"slotNumber,omitempty\""
    observedTag: z.string().nullable(),    // the tag actually on the mirror member, e.g. "json:\"slotNumber\""
    actual: z.enum(["missing", "tag-diverged", "present"]),
  }).nullable().optional(),
}))
```

`observedTag` is required to make `tag-diverged` verifiable: without it the verifier can only see
"expectedTag absent", which a field with **no tag** or a **wrong unrelated tag** would also satisfy.
With `observedTag` the verifier can confirm the member carries a *real, different* tag.

Compat to spell out for the implementer: (a) **storage** — serializes into the existing `evidence`
TEXT/JSON column, no new migration; (b) **audit** — `writeAuditEntry({type:"verdict", verdict})` already
persists the whole object; (c) **human visibility** — medium-severity drift produces **no alert card**
(`alert-card.ts` returns `null` below high), and the daily digest query
(`report.ts` `subThresholdFindings` → `buildSubThresholdDigestLine`) reads only `severity`+`summary`,
**not** `evidence`. So the mirror gap must be stated in the `summary` (the agent MUST describe the gap
there) to be visible in the digest. The `contractCheck` struct is for verification + audit + (when
severity is high/critical) the alert card; surfacing structured `contractCheck` *inside the digest* is a
separate report-rendering change, out of v1 scope. (Alternative storage: a top-level `mirrorEvidence`
array + new `mirror_evidence` column — more explicit but needs a migration. Pick one and state it.)

### Evidence verification rules (branch by `actual`)

`verifyEvidence` only confirms a cited snippet *exists*; it cannot validate "missing"/"diverged" claims
and a coarse "expected string absent" check would pass a wrong candidate. Each `contractCheck` evidence
item MUST cite the **full enclosing mirror definition** as its `snippet`, and the verifier branches:

- `actual: "missing"` — verify: (1) the enclosing-struct snippet exists in the cited file/lines, AND
  (2) the `member` identifier is **NOT** present within that snippet.
- `actual: "tag-diverged"` — verify: (1) snippet exists, AND (2) the `member` **is** present, AND
  (3) the `observedTag` **is** present on that member, AND (4) `observedTag` **≠** `expectedTag` (and
  `expectedTag` is not present). This distinguishes "field has the old/different tag" from "field has no
  tag" or "wrong mirror lacking the field", both of which would otherwise sneak through.
- `actual: "present"` — verify the `member` (and `expectedTag` when given) **is** present (used to back
  `affected: no` / negative verdicts).

A `contractCheck` whose branch checks fail → treat like failed evidence verification today (drop
confidence to `low`), so an unverifiable mirror claim cannot drive a `yes`.

### Severity
Unchanged: mirror-sync gaps for additive/optional fields are compatibility adaptations → `medium`,
digest, not a critical push (consistent with the severity bar). A mirror gap on a consensus-critical
parse/encode path would still be `high`/`critical` by the existing severity rules.

---

## 4. Scope & non-goals

- **In scope:** detect drift between an upstream contract change and a downstream *local copy* of that
  contract, generically (struct fields, wire tags, enums, signatures, constants, API method lists).
- **Out of scope:** reading source that lives only in an external dependency (e.g. confirming whether
  `mantlenetworkio/op-geth` itself carries the change). The mirror check sidesteps this for mirrored
  contracts; non-mirrored external-dep cases remain `uncertain` by design (safe, no false alert).
- **Not changing:** the alert gate (severity critical/high), the relationship map, or the queue.

---

## 5. Validation plan

Re-run `references/tests/impact-check-cases.json` via `scripts/analyze-pr.ts --ref <pre-adaptation>`:

| Case | Pin | Expected after fix |
|---|---|---|
| C1 positive | `46803658` | `affected: yes`, severity ≥ medium, evidence = full `RPCHeader` block showing `SlotNumber` absent |
| C1 negative | `0c77c603` | `affected: no`/`uncertain` (RPCHeader has SlotNumber — no mirror drift; any residual uncertainty is the external op-geth side) |
| C2 positive | `0c77c603` | `affected: no` — see the **C2 correction** in §3: payload-domain change has no synced same-domain mirror; NOT detectable by domain-respecting structural detection |
| C2 negative | `32f5a6ad` | `affected: no` (tag already has omitempty) |

Success = the C1 **positive** flips to `yes` with structured, file-verified evidence citing the stale
local mirror (the headline capability that was missing). C1 negative shows no mirror drift (no false
positive). C2 is a documented limitation (both `no`). See the authoritative replay outcomes in
`references/tests/impact-check-cases.json` → `_validationResults_2026-06-15`.

**Reproducible no-regression check (do NOT use ephemeral DB row IDs).** The earlier "#99/#100/#103/#95"
references were `impact_checks` row IDs in a local `monitor.db` — not portable and not reproducible by
the implementer. Instead, fixture-ize 2–3 representative `depends_on` cases into
`impact-check-cases.json` with explicit `{upstream PR, target, --ref, expected}`:
- a clean **`no`** via manifest (component pinned before the change / absent), and
- the external-dep **`uncertain`** case (consumed source not in clone, e.g. the go-ethereum→mantle-v2
  op-geth path) — must stay `uncertain`, NOT become a false `yes` from the new mirror phase.
Regression = these fixtures keep their expected verdicts after the change.

> Test-suite note for the implementer: `bun test` over multiple impact-checker files together currently
> hits a Bun `mock.module` ordering issue (`daily.test.ts` mocking `budget-tracker` leaks into
> `impact-checker/index.test.ts`). Run the affected files individually until that isolation bug is fixed;
> it is pre-existing and unrelated to this change.

### Unit fixtures (required, not just the live replays)

Add fast offline tests that don't need a live clone/LLM, so the mirror finder's core invariants are
pinned:

1. **Stale-mirror detection (P1 regression).** Fixture: (a) an upstream diff adding a field to a struct,
   (b) a `target-pre` file whose mirror has the sibling fields but **not** the new field, (c) a
   `target-post` file with the field present. Assert `findLocalContractMirrors` locates the mirror in
   `target-pre` **even though the new identifier is entirely absent**, reports the delta `missing`, and
   reports `present` in `target-post`.
2. **Tag-divergence detection.** Fixture where the mirror has the field but with the old tag
   (`json:"slotNumber"`); assert `actual: "tag-diverged"` and that the verifier's three-way check passes
   only when field-present + old-tag-present + expected-tag-absent all hold.
3. **False-positive guard (required).** Fixture with an unrelated struct that shares ONLY the field name
   (e.g. a metrics struct with a lone `slotNumber`) and no sibling overlap / arch-path; assert it is
   **NOT** matched as a mirror (exercises the ≥2-sibling-overlap v1 rule).

Cover both a Go struct-field/tag case and a Rust struct/serde-field case for (1) and (2).

---

## 6. Implementation approach

Build this as a **deterministic pre-pass feeding LLM reasoning**, not pure prompt — the pre-pass makes
the "field absent" case reliably detectable; the LLM handles impact interpretation + severity.

- `extractContractDeltas(diff)` → structured deltas (enclosingContract, siblingMembers, delta,
  serializedKey, semanticDomain). Language extractors required for **Go struct fields + tags** and
  **Rust struct/serde fields**; degrade gracefully (hand to LLM) for other shapes.
- `findLocalContractMirrors(cloneDir, delta)` → locate mirrors by sibling/serialized-key overlap (NOT
  the new identifier) and return `{ mirror, file, lines, deltaPresent: bool, divergence }`.
- The strategy/agent consumes these structured results to explain impact, pick `impactType`/`severity`,
  and emit absence/divergence evidence; `verifyEvidence` validates the absence claim (see §3).

Touched components: new extractor/mirror-finder module under `src/extensions/impact-checker/`;
`strategies.ts` (`depends_on` gains the mirror phase); `prompts/impact-check/fork.md` (verdict
definition + output rules); `checker.ts` (`verifyEvidence` absence handling, structured evidence).

## 7. Decisions locked for v1 / remaining open questions

**Locked (no longer open — implement as stated):**
- Cross-struct identity → match, with the 3 guardrails (§3).
- LLM-only vs pre-pass → deterministic pre-pass + LLM reasoning (§6).
- Mirror-match threshold → **≥2 sibling overlaps OR explicit architecture-notes path** (§3 Step B), with
  the required false-positive fixture (§5).
- Structured evidence → first-class `evidence[].contractCheck` schema field + per-`actual` verifier
  branches (§3).

**Still open (do not block v1 — pick a default, note it):**
1. **Extractor coverage scope.** v1 = Go struct fields+tags and Rust struct/serde fields. Enums,
   exported-signature changes, API-method-list and config-key contracts are listed but lower priority —
   confirm whether any are needed for v1 or deferred.
2. **Cost.** The mirror pre-pass + search adds steps; expected to fit `maxStepsPerCheck=25` /
   `maxCostPerCheck=$1` (the pre-pass replaces the flailing that currently exhausts steps), but confirm
   on the replay + one large-diff PR.
