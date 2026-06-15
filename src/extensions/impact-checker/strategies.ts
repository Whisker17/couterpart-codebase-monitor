import type { CounterpartRelationship } from "../../config/projects";

export type RelationshipType = CounterpartRelationship["relationship"];

/**
 * Returns the check instruction string that primes the agent for the given relationship type.
 * Phase 1 supports fork_of only.
 */
export function getCheckInstructions(relationship: RelationshipType): string {
  switch (relationship) {
    case "fork_of":
      return getForkOfInstructions();
    case "depends_on":
      return getDependsOnInstructions();
    default:
      return getGenericInstructions(relationship);
  }
}

function getForkOfInstructions(): string {
  return `
## Your Investigation Task (fork_of)

You are investigating whether a change in the upstream repository has impacted this fork.

**Follow this three-phase investigation sequence:**

### Phase 1 — Locate the upstream change in this fork
1. Use \`grep_repo\` to find functions, types, or code patterns changed in the upstream PR.
   - Search by function names, error messages, constants, or distinctive identifiers from the upstream diff.
   - Use multiple searches if needed: first broad, then targeted.
   - The upstream code and fork code may have diverged — look for similar logic, not necessarily identical code.

### Phase 2 — Compare: does this fork share the bug or need the fix?
2. Use \`read_file\` to read the relevant files and lines you found in Phase 1.
   - Compare the actual code in the fork to the upstream change.
   - Determine:
     - Is the same vulnerable/buggy code present in the fork? (→ affected: yes)
     - Has the fix already been cherry-picked or independently implemented? (→ affected: no)
     - Has the fork diverged significantly enough that the upstream change doesn't apply? (→ affected: no or uncertain)
     - Can you not determine this with confidence? (→ affected: uncertain)

### Phase 3 — Assess impact on Mantle's side
3. If the bug or breaking change is present in the fork:
   - Assess the blast radius: which components use the affected code?
   - Consider the architecture notes provided for this target.
   - Determine the impact type: bug_also_present, breaking_change, downtime_risk, behavior_change.
   - Set **severity** on operational grounds (see "Operational Severity"): a change that can halt the
     chain or break consensus/parsing is \`critical\`; one that breaks build/runtime/API compatibility is
     \`high\`; a missing-feature/CLI/doc divergence the chain runs fine without is \`low\`.

**Evidence requirements:**
- Your verdict MUST include code_evidence: file path + exact line range + actual code snippet.
- Do not conclude "affected: yes" without reading the file and confirming the code.
- Do not conclude "affected: no" without positive evidence of absence or a cherry-picked fix.
- If you cannot find the code after 3 targeted searches, use "uncertain" with reasoning_based evidence.
`.trim();
}

function getDependsOnInstructions(): string {
  return `
## Your Investigation Task (depends_on)

This target does NOT fork the upstream wholesale. It **consumes** the upstream as a
dependency — typically pinned to a specific version/rev, often re-routed through an
intermediate Mantle fork. The upstream change matters only if it lands in a component,
version, and code path this target actually consumes. Your first job is to establish that
dependency boundary from the manifests, not to grep for code blindly.

**Follow this three-phase investigation sequence:**

### Phase 1 — Establish the dependency boundary (manifests first)
1. Identify which upstream component the PR touches (crate, Go module, or package) from the diff.
2. Use \`grep_repo\` / \`read_file\` on the target's dependency manifests to find how — and at what
   version — it consumes that component:
   - **Rust**: \`Cargo.toml\` (\`[dependencies]\`, \`[patch.crates-io]\`, \`[workspace.dependencies]\`)
     and \`Cargo.lock\` (resolved version + git \`rev\`/\`source\`). Note any \`[patch]\` redirect to a
     mantle-xyz fork and the locked rev.
   - **Go**: \`go.mod\` (\`require\` + \`replace\`) and \`go.sum\`. Note any \`replace\` pointing at a
     Mantle fork (e.g. op-geth) and the pinned version/pseudo-version.
   - **Vendored / subtree**: a copied path inside the repo pinned at a tag.
3. Determine: is this component even in the target's dependency graph? At what version/rev?
   Is it consumed directly or via an intermediate Mantle fork?

### Phase 2 — Is the upstream change in-scope for the consumed version?
4. Decide whether the changed code can actually reach this target:
   - The component is **NOT a dependency** of the target → \`affected: no\` (manifest_evidence).
   - The target pins a **version/rev BEFORE the change** → not yet inherited → \`affected: no\`
     (it will only matter on a future bump; say so in recommended_action).
   - The target pins a **version/rev AT or AFTER the change** → the change is (or will be)
     present → continue to Phase 3.
   - Consumption goes through a Mantle fork: use \`grep_repo\`/\`read_file\` to check whether that
     fork has already re-ported or diverged from the changed code.

### Phase 3 — Assess impact at the consumption boundary
5. If the change is in-scope, assess how it reaches this target:
   - Does it change a public API / type / signature the target calls? → \`breaking_change\`.
   - Does it change runtime behavior (gas, consensus, encoding, RPC) of a consumed path? → \`behavior_change\`.
   - Is it a bug present in the consumed version? → \`bug_also_present\`.
   - Use the architecture notes for the consumption chain (e.g. go-ethereum → op-geth → mantle op-geth → mantle-v2).
6. Set **severity** on operational grounds (see "Operational Severity"). Protocol-level changes flowing down
   a dependency chain — block-header/consensus/gas/encoding (e.g. an L1 EIP), or a breaking API at a consumed
   crate/module boundary — are typically \`critical\` or \`high\`. A change to a component the target does not
   consume, or one with no runtime effect, is \`low\`.

**Evidence requirements:**
- Prefer **manifest_evidence** (the \`Cargo.toml\`/\`Cargo.lock\`/\`go.mod\` line proving consumption,
  the version/rev, or proving the component is absent) — for depends_on, the dependency boundary
  IS the key fact.
- Add **code_evidence** (file + line range + snippet) when you confirm a changed path is reachable.
- "affected: no" is a STRONG, expected conclusion here when the manifest shows the component is not
  consumed or is pinned before the change — back it with the manifest line and use **high** confidence.
  Do not default to "uncertain" when the manifest gives you a clear answer.
- Use "uncertain" only when you genuinely cannot resolve the version boundary after reading the manifests.
`.trim();
}

function getGenericInstructions(relationship: RelationshipType): string {
  return `
## Your Investigation Task (${relationship})

Investigate whether the upstream change impacts this target based on their ${relationship} relationship.

1. Use \`grep_repo\` to search for relevant code patterns from the upstream PR.
2. Use \`read_file\` to read and compare identified files.
3. Assess whether the target is affected.

Provide code_evidence with file path, line range, and snippet wherever possible.
`.trim();
}
