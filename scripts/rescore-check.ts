// Re-score one or more impact_checks by id against the cached clone using the current
// prompt/schema, print severity + whether it would now alert. Writes severity/affected
// back to the row so DB state matches the new model.
//   bun run scripts/rescore-check.ts 94 [123 ...]
import { readFileSync } from "node:fs";
import { getDb } from "../src/storage/db";
import { getSettings } from "../src/config/settings";
import { getMantleConfig } from "../src/config/projects";
import { syncTarget } from "../src/extensions/impact-checker/clone-manager";
import { runImpactCheck } from "../src/extensions/impact-checker/checker";
import type { CheckerInput } from "../src/extensions/impact-checker/checker";
import { renderAlertCard } from "../src/extensions/impact-checker/alert-card";

const ids = process.argv.slice(2).map((s) => parseInt(s, 10)).filter((n) => Number.isInteger(n));
if (!ids.length) {
  console.error("usage: bun run scripts/rescore-check.ts <id> [<id> ...]");
  process.exit(1);
}

const db = getDb();
const settings = getSettings();
const mc = getMantleConfig();
const cloneOpts = {
  clonesDir: settings.impactCheck!.clonesDir,
  maxCloneDiskGB: settings.impactCheck!.maxCloneDiskGB,
};

function mapDiffStatus(s: string): "available" | "unavailable" | "too_large" {
  if (s === "available") return "available";
  if (s === "too_large") return "too_large";
  return "unavailable";
}

const cloneCache = new Map<string, Awaited<ReturnType<typeof syncTarget>>>();

for (const id of ids) {
  const row = db
    .query<
      {
        pr_id: number;
        analysis_id: number;
        target_project_id: string;
        relationship: string;
        old_affected: string | null;
        old_severity: string | null;
      },
      [number]
    >(
      `SELECT pr_id, analysis_id, target_project_id, relationship,
              affected AS old_affected, severity AS old_severity
       FROM impact_checks WHERE id = ?`
    )
    .get(id);
  if (!row) {
    console.log(`#${id}: not found`);
    continue;
  }

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
  const target = mc.mantleTargets.find((t) => t.projectId === row.target_project_id);
  const rel = mc.counterpartRelationships.find(
    (r) =>
      r.source === pr?.project_id &&
      r.relationship === row.relationship &&
      r.targets.includes(row.target_project_id)
  );
  if (!pr || !target || !rel) {
    console.log(`#${id}: missing pr/target/relationship`);
    continue;
  }

  let clone = cloneCache.get(target.projectId);
  if (!clone) {
    clone = await syncTarget(target, cloneOpts);
    cloneCache.set(target.projectId, clone);
  }
  if (!clone.available) {
    console.log(`#${id}: clone unavailable`);
    continue;
  }

  const diffStatus = mapDiffStatus(pr.diff_status);
  const input: CheckerInput = {
    checkId: `rescore-${id}`,
    target,
    relationship: rel,
    cloneState: { cloneDir: clone.cloneDir, commitHash: clone.commitHash, lastFetchAt: clone.lastFetchAt },
    upstreamPR: {
      title: pr.title,
      body: pr.body,
      diffRaw: diffStatus === "available" && pr.diff_path ? safeRead(pr.diff_path) : null,
      diffStatus,
    },
    analyzerSummary: pr.summary ? { summary: pr.summary, technicalDetail: pr.technical_detail ?? "" } : null,
  };

  const v = await runImpactCheck(input);
  const card = renderAlertCard({
    checkId: id,
    verdict: v,
    prNumber: pr.pr_number,
    prTitle: pr.title,
    sourceProjectId: pr.project_id,
    targetProjectId: row.target_project_id,
    targetCommit: clone.commitHash,
  });
  const wouldAlert = card !== null;

  db.query(
    `UPDATE impact_checks SET affected=?, severity=?, impact_type=?, evidence_kind=?,
       evidence=?, confidence=?, summary=?, recommended_action=?, alert_card_json=?, checked_at=unixepoch()
     WHERE id=?`
  ).run(
    v.affected,
    v.severity,
    v.impactType,
    v.evidenceKind,
    JSON.stringify(v.evidence),
    v.confidence,
    v.summary,
    v.recommendedAction,
    card,
    id
  );

  console.log(
    `#${id} ${pr.project_id}#${pr.pr_number} -> ${row.target_project_id}: ` +
      `${row.old_affected}/${row.old_severity ?? "null"} => ${v.affected}/${v.severity} ` +
      `[${v.evidenceKind}, conf=${v.confidence}, ${v.toolSteps} steps, $${v.cost.toFixed(3)}] ` +
      `wouldAlert=${wouldAlert}`
  );
  console.log(`     ${v.summary.slice(0, 180)}`);
}

function safeRead(p: string): string | null {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}
