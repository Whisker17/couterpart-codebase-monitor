// One-off: re-run the completed depends_on impact-checks against the cached clones
// using the improved depends_on strategy prompt, and print old -> new verdict deltas.
// Read-only: does NOT mutate impact_checks or touch the daily quota/queue.
//
//   bun run scripts/revalidate-depends-on.ts
import { readFileSync } from "node:fs";
import { getDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import { getMantleConfig } from "../src/config/projects";
import { syncTarget } from "../src/extensions/impact-checker/clone-manager";
import { runImpactCheck } from "../src/extensions/impact-checker/checker";
import type { CheckerInput } from "../src/extensions/impact-checker/checker";

function mapDiffStatus(s: string): "available" | "unavailable" | "too_large" {
  if (s === "available") return "available";
  if (s === "too_large") return "too_large";
  return "unavailable";
}
function readDiffRaw(p: string | null): string | null {
  if (!p) return null;
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

const db = getDb();
const settings = getSettings();
const mc = getMantleConfig();
const cloneOpts = {
  clonesDir: settings.impactCheck!.clonesDir,
  maxCloneDiskGB: settings.impactCheck!.maxCloneDiskGB,
};

const rows = db
  .query<
    {
      id: number;
      pr_id: number;
      analysis_id: number;
      target_project_id: string;
      relationship: string;
      old_affected: string;
      old_confidence: string;
    },
    []
  >(
    `SELECT id, pr_id, analysis_id, target_project_id, relationship,
            affected AS old_affected, confidence AS old_confidence
     FROM impact_checks
     WHERE status='complete' AND relationship='depends_on'
     ORDER BY id`
  )
  .all();

console.log(`Re-validating ${rows.length} depends_on checks against cached clones...\n`);

const cloneCache = new Map<string, Awaited<ReturnType<typeof syncTarget>>>();
let totalCost = 0;
const deltas: string[] = [];

for (const row of rows) {
  const target = mc.mantleTargets.find((t) => t.projectId === row.target_project_id);
  const pr = db
    .query<
      {
        title: string;
        body: string | null;
        diff_status: string;
        diff_path: string | null;
        summary: string;
        technical_detail: string | null;
        pr_number: number;
        project_id: string;
      },
      [number, number]
    >(
      `SELECT pr.title, pr.body, pr.diff_status, pr.diff_path, a.summary, a.technical_detail,
              pr.pr_number, pr.project_id
       FROM pull_requests pr JOIN analyses a ON a.pr_id = pr.id AND a.id = ?
       WHERE pr.id = ?`
    )
    .get(row.analysis_id, row.pr_id);
  const rel = mc.counterpartRelationships.find(
    (r) =>
      r.source === pr?.project_id &&
      r.relationship === "depends_on" &&
      r.targets.includes(row.target_project_id)
  );
  if (!target || !pr || !rel) {
    console.log(`#${row.id}: SKIP (missing target/pr/relationship)`);
    continue;
  }

  let clone = cloneCache.get(target.projectId);
  if (!clone) {
    clone = await syncTarget(target, cloneOpts);
    cloneCache.set(target.projectId, clone);
  }
  if (!clone.available) {
    console.log(`#${row.id}: SKIP (clone unavailable for ${target.projectId})`);
    continue;
  }

  const diffStatus = mapDiffStatus(pr.diff_status);
  const input: CheckerInput = {
    checkId: `reval-${row.id}`,
    target,
    relationship: rel,
    cloneState: {
      cloneDir: clone.cloneDir,
      commitHash: clone.commitHash,
      lastFetchAt: clone.lastFetchAt,
    },
    upstreamPR: {
      title: pr.title,
      body: pr.body,
      diffRaw: diffStatus === "available" ? readDiffRaw(pr.diff_path) : null,
      diffStatus,
    },
    analyzerSummary: pr.summary
      ? { summary: pr.summary, technicalDetail: pr.technical_detail ?? "" }
      : null,
  };

  try {
    const v = await runImpactCheck(input);
    totalCost += v.cost;
    const before = `${row.old_affected}/${row.old_confidence}`;
    const after = `${v.affected}/${v.confidence}`;
    const changed = before !== after ? "  <== CHANGED" : "";
    const line = `#${row.id} ${pr.project_id}#${pr.pr_number} -> ${row.target_project_id}: ${before} => ${after} [${v.evidenceKind}, ${v.toolSteps} steps, $${v.cost.toFixed(3)}]${changed}`;
    console.log(line);
    console.log(`     ${v.summary.slice(0, 160)}`);
    deltas.push(line);
  } catch (e) {
    console.log(`#${row.id}: ERROR ${e instanceof Error ? e.message : String(e)}`);
  }
}

console.log(`\n=== SUMMARY ===`);
for (const d of deltas) console.log(d);
console.log(`\nTotal re-validation cost: $${totalCost.toFixed(3)}`);
