import { createHash } from "crypto";
import type { Database } from "bun:sqlite";
import type { ImpactCheckConfig } from "../../config/settings";
import type { CounterpartRelationship, MantleConfig, MantleTarget } from "../../config/projects";
import { getBudgetStatus, getImpactCheckBudgetStatus } from "../../utils/budget-tracker";

export const IMPACT_CHECK_PROMPT_VERSION = "v1";

type Significance = "routine" | "notable" | "directional_shift";
type DownstreamImpactHint = "none" | "possible" | "likely";
// "manual" is valid in CounterpartRelationship but not in impact_checks schema
type ImpactRelationship = "fork_of" | "depends_on" | "protocol_dependency";

export interface GateInput {
  prId: number;
  analysisId: number;
  projectId: string;
  significance: Significance | null;
  downstreamImpactHint: DownstreamImpactHint | null;
  mergedAt: number | null;
}

export interface QueueStats {
  expired: number;
  revived: number;
  skippedBudget: number;
}

export interface PendingRow {
  id: number;
  pr_id: number;
  analysis_id: number;
  target_project_id: string;
  relationship: ImpactRelationship;
  config_hash: string;
  prompt_version: string;
}

// ---- Config hash ----

export function computeConfigHash(rel: CounterpartRelationship, target: MantleTarget): string {
  const payload = JSON.stringify({
    relationship: rel.relationship,
    reason: rel.reason,
    repoUrl: target.repoUrl ?? null,
    branch: target.branch ?? null,
    architectureNotes: target.architectureNotes ?? null,
    notes: target.notes ?? null,
    tags: [...(target.tags ?? [])].sort(),
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ---- Gate judgment ----

export function shouldEnqueue(input: GateInput, maxAgeDays: number): boolean {
  if (input.mergedAt === null) return false;
  const ageDays = (Date.now() / 1000 - input.mergedAt) / 86400;
  if (ageDays > maxAgeDays) return false;

  const hint = input.downstreamImpactHint ?? "none";
  const sig = input.significance;

  return hint !== "none" || sig === "notable" || sig === "directional_shift";
}

// ---- Upsert ----

function getChanges(db: Database): number {
  return db.query<{ c: number }, []>("SELECT changes() as c").get()!.c;
}

export function upsertImpactChecks(
  db: Database,
  inputs: GateInput[],
  mantleConfig: MantleConfig,
  impactCheckConfig: ImpactCheckConfig
): number {
  const targetMap = new Map<string, MantleTarget>();
  for (const t of mantleConfig.mantleTargets) {
    targetMap.set(t.projectId, t);
  }

  // Group valid (source → [{rel, target}]) — skip "manual" relationships not in DB schema
  const relsBySource = new Map<string, Array<{ rel: CounterpartRelationship; target: MantleTarget }>>();
  for (const rel of mantleConfig.counterpartRelationships) {
    if (rel.relationship === "manual") continue;
    for (const targetId of rel.targets) {
      const target = targetMap.get(targetId);
      if (!target) continue;
      const list = relsBySource.get(rel.source) ?? [];
      list.push({ rel, target });
      relsBySource.set(rel.source, list);
    }
  }

  let upserted = 0;

  for (const input of inputs) {
    const pairs = relsBySource.get(input.projectId);
    if (!pairs || pairs.length === 0) continue;
    if (!shouldEnqueue(input, impactCheckConfig.maxAgeDays)) continue;

    for (const { rel, target } of pairs) {
      const configHash = computeConfigHash(rel, target);
      const promptVersion = IMPACT_CHECK_PROMPT_VERSION;

      db.query(`
        INSERT INTO impact_checks
          (pr_id, analysis_id, target_project_id, relationship, config_hash, prompt_version, status, retry_count)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0)
        ON CONFLICT(pr_id, target_project_id) DO UPDATE SET
          analysis_id = excluded.analysis_id,
          relationship = excluded.relationship,
          config_hash = excluded.config_hash,
          prompt_version = excluded.prompt_version,
          status = 'pending',
          retry_count = 0
        WHERE impact_checks.status IN ('pending','failed','skipped_budget','expired')
          AND (impact_checks.analysis_id != excluded.analysis_id
               OR impact_checks.config_hash IS NOT excluded.config_hash
               OR impact_checks.prompt_version IS NOT excluded.prompt_version)
      `).run(
        input.prId,
        input.analysisId,
        target.projectId,
        rel.relationship,
        configHash,
        promptVersion
      );
      upserted += getChanges(db);
    }
  }

  return upserted;
}

// ---- Queue governance ----

export function processQueue(db: Database, config: ImpactCheckConfig): QueueStats {
  const stats: QueueStats = { expired: 0, revived: 0, skippedBudget: 0 };
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - config.maxAgeDays * 86400;

  // 1. Expire pending and failed rows whose PR merge time exceeds maxAgeDays.
  // Failed rows must be expired here before retry revival so over-age PRs are not revived.
  db.query(`
    UPDATE impact_checks SET status = 'expired'
    WHERE status IN ('pending', 'failed')
      AND pr_id IN (
        SELECT id FROM pull_requests WHERE merged_at < ? AND merged_at IS NOT NULL
      )
  `).run(cutoff);
  stats.expired = getChanges(db);

  // 2. Revive failed rows with retry_count < 3
  db.query(`
    UPDATE impact_checks SET status = 'pending'
    WHERE status = 'failed' AND retry_count < 3
  `).run();
  stats.revived = getChanges(db);

  // 3. Budget shutdown: sub-limit or total pool triggers skipped_budget
  const budgetStatus = getBudgetStatus();
  const impactBudgetStatus = getImpactCheckBudgetStatus();

  if (budgetStatus.action === "pause" || impactBudgetStatus.action === "pause") {
    db.query(`
      UPDATE impact_checks SET status = 'skipped_budget'
      WHERE status = 'pending'
    `).run();
    stats.skippedBudget = getChanges(db);
    return stats;
  }

  return stats;
}

// ---- Priority queue query for Phase 2 consumers ----

export function getPendingQueue(db: Database, config: ImpactCheckConfig): PendingRow[] {
  const todayStart = Math.floor(
    Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000
  );

  const { count: decidedToday } = db
    .query<{ count: number }, [number]>(
      "SELECT COUNT(*) as count FROM impact_checks WHERE checked_at IS NOT NULL AND checked_at >= ?"
    )
    .get(todayStart)!;

  const remaining = Math.max(0, config.maxChecksPerDay - decidedToday);
  if (remaining === 0) return [];

  return db
    .query<PendingRow, [number]>(`
      SELECT ic.id, ic.pr_id, ic.analysis_id, ic.target_project_id, ic.relationship, ic.config_hash, ic.prompt_version
      FROM impact_checks ic
      JOIN analyses a ON ic.analysis_id = a.id
      JOIN pull_requests pr ON ic.pr_id = pr.id
      WHERE ic.status = 'pending'
      ORDER BY
        CASE a.significance
          WHEN 'directional_shift' THEN 2
          WHEN 'notable' THEN 1
          ELSE 0
        END DESC,
        CASE a.downstream_impact_hint
          WHEN 'likely' THEN 2
          WHEN 'possible' THEN 1
          ELSE 0
        END DESC,
        pr.merged_at DESC
      LIMIT ?
    `)
    .all(remaining);
}
