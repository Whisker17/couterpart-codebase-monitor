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

**Evidence requirements:**
- Your verdict MUST include code_evidence: file path + exact line range + actual code snippet.
- Do not conclude "affected: yes" without reading the file and confirming the code.
- Do not conclude "affected: no" without positive evidence of absence or a cherry-picked fix.
- If you cannot find the code after 3 targeted searches, use "uncertain" with reasoning_based evidence.
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
