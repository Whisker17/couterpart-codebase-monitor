import { createWriteStream, mkdirSync } from "fs";
import { dirname } from "path";
import { getDb } from "../storage/db";

interface AnalysisRow {
  analysis_id: number;
  pr_id: number;
  project_id: string;
  summary: string;
  technical_detail: string | null;
  direction_signal: string | null;
  significance: string;
  categories: string | null;
  model_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  estimated_cost_usd: number | null;
  analyzed_at: number;
  prompt_version: string;
  input_quality: string;
  rendered_project_context: string | null;
  file_manifest: string | null;
  diff_included_files: number | null;
  diff_total_files: number | null;
  diff_truncated: number;
  truncated_diff_path: string | null;
  pr_number: number;
  title: string;
  author: string | null;
  body: string | null;
  merged_at: number | null;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
}

export async function exportAnalyses(
  since: Date,
  until: Date,
  outputPath: string
): Promise<number> {
  const db = getDb();
  const sinceUnix = Math.floor(since.getTime() / 1000);
  const untilUnix = Math.floor(until.getTime() / 1000);

  const rows = db
    .query<AnalysisRow, [number, number]>(
      `SELECT
         a.id          AS analysis_id,
         a.pr_id,
         a.project_id,
         a.summary,
         a.technical_detail,
         a.direction_signal,
         a.significance,
         a.categories,
         a.model_id,
         a.input_tokens,
         a.output_tokens,
         a.estimated_cost_usd,
         a.analyzed_at,
         ai.prompt_version,
         ai.input_quality,
         ai.rendered_project_context,
         ai.file_manifest,
         ai.diff_included_files,
         ai.diff_total_files,
         ai.diff_truncated,
         ai.truncated_diff_path,
         pr.pr_number,
         pr.title,
         pr.author,
         pr.body,
         pr.merged_at,
         pr.files_changed,
         pr.additions,
         pr.deletions
       FROM analyses a
       JOIN analysis_inputs ai ON ai.analysis_id = a.id
       JOIN pull_requests pr   ON pr.id = a.pr_id
       WHERE a.analyzed_at >= ? AND a.analyzed_at < ?
       ORDER BY a.analyzed_at ASC`
    )
    .all(sinceUnix, untilUnix);

  mkdirSync(dirname(outputPath), { recursive: true });
  const out = createWriteStream(outputPath, { encoding: "utf-8" });

  await new Promise<void>((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", resolve);

    for (const row of rows) {
      const line = JSON.stringify({
        analysis: {
          id: row.analysis_id,
          pr_id: row.pr_id,
          project_id: row.project_id,
          summary: row.summary,
          technical_detail: row.technical_detail,
          direction_signal: row.direction_signal,
          significance: row.significance,
          categories: row.categories ? JSON.parse(row.categories) : [],
          model_id: row.model_id,
          input_tokens: row.input_tokens,
          output_tokens: row.output_tokens,
          estimated_cost_usd: row.estimated_cost_usd,
          analyzed_at: row.analyzed_at,
        },
        analysis_inputs: {
          prompt_version: row.prompt_version,
          input_quality: row.input_quality,
          rendered_project_context: row.rendered_project_context,
          file_manifest: row.file_manifest,
          diff_included_files: row.diff_included_files,
          diff_total_files: row.diff_total_files,
          diff_truncated: row.diff_truncated === 1,
          truncated_diff_path: row.truncated_diff_path,
        },
        pr_metadata: {
          pr_id: row.pr_id,
          pr_number: row.pr_number,
          title: row.title,
          author: row.author,
          body: row.body,
          merged_at: row.merged_at,
          files_changed: row.files_changed,
          additions: row.additions,
          deletions: row.deletions,
        },
      });
      out.write(line + "\n");
    }

    out.end();
  });

  return rows.length;
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  function getArg(flag: string): string | undefined {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  }

  const sinceArg = getArg("--since");
  const untilArg = getArg("--until");
  const outputArg = getArg("--output");

  if (!sinceArg || !untilArg || !outputArg) {
    console.error("Usage: bun run src/utils/audit-export.ts --since <date> --until <date> --output <path>");
    process.exit(1);
  }

  const since = new Date(sinceArg);
  const until = new Date(untilArg);

  if (isNaN(since.getTime()) || isNaN(until.getTime())) {
    console.error("Invalid date format. Use ISO 8601 (e.g. 2026-06-10).");
    process.exit(1);
  }

  exportAnalyses(since, until, outputArg)
    .then((count) => {
      console.log(`Exported ${count} record(s) to ${outputArg}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Export failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
