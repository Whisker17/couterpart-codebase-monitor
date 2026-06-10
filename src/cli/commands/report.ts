import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getDb } from "../../storage/db";
import { getSettings } from "../../config/settings";
import { getDayPeriod, getMonthPeriod, getWeekPeriod } from "../../utils/time-window";
import { buildDailyPromptInputForPeriod } from "../../extensions/report-generator/daily-prompt-input";
import { renderDailyPrompt } from "../../extensions/report-generator/daily-prompt-input";
import { DEFAULT_DAILY_PROMPT_PATH, generateDailyPromptReportForPeriod } from "../../extensions/report-generator/daily-prompt-report";
import { buildDailyReportForPeriod } from "../../extensions/report-generator/daily";
import { generateWeeklyPromptReport } from "../../extensions/report-generator/weekly-prompt-report";
import { generateMonthlyPromptReport } from "../../extensions/report-generator/monthly-prompt-report";
import { buildDailyPromptCard } from "../../extensions/report-generator/templates/daily-prompt-card";
import { buildWeeklyPromptCard } from "../../extensions/report-generator/templates/weekly-prompt-card";
import { buildMonthlyPromptCard } from "../../extensions/report-generator/templates/monthly-prompt-card";
import { sendCard } from "../../extensions/lark-dispatcher/webhook";
import { flagBool, flagString, type FlagValue, type GlobalFlags } from "../args";

export type ReportType = "daily" | "weekly" | "monthly";
export type DeliveryStatus = "pending" | "sent" | "failed";
export type RedispatchMode = "full" | "report-only" | "dispatch-only";

export interface ReportPeriod {
  type: ReportType;
  startUnix: number;
  endUnix: number;
  label: string;
}

export interface ReportRow {
  id: number;
  type: string;
  period_start: number;
  period_end: number;
  content: string;
  sent_at: number | null;
}

export interface DeliveryRow {
  id: number;
  report_id: number;
  card_index: number;
  content: string;
  status: DeliveryStatus;
  lark_message_id: string | null;
  sent_at: number | null;
}

export interface MarkDeliveryOptions {
  reportId: number;
  status: DeliveryStatus;
  cardIndex?: number;
  yes: boolean;
}

export interface MarkDeliveryResult {
  mutated: boolean;
  before: DeliveryRow[];
  after: DeliveryRow[];
}

export interface RedispatchPrepareOptions {
  reportId: number;
  mode: RedispatchMode;
  yes: boolean;
}

export interface RedispatchPrepareResult {
  mutated: boolean;
  before: DeliveryRow[];
  after: DeliveryRow[];
  refreshed: boolean;
}

export interface RedispatchDispatchResult {
  sent: number;
  failed: number;
  errors: string[];
}

function assertDate(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${flag} "${value}". Expected YYYY-MM-DD.`);
  }
  return value;
}

function assertMonth(value: string | undefined): string {
  if (!value) throw new Error("--month is required");
  if (!/^\d{4}-\d{2}$/.test(value)) {
    throw new Error(`Invalid --month "${value}". Expected YYYY-MM.`);
  }
  const month = Number(value.slice(5, 7));
  if (month < 1 || month > 12) throw new Error(`Invalid --month "${value}". Expected month 01-12.`);
  return value;
}

function fmtDate(unix: number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(unix * 1000));
}

export function resolveReportPeriod(
  type: ReportType,
  flags: Record<string, FlagValue>,
  timezone: string,
  now = new Date()
): ReportPeriod {
  if (type === "daily") {
    const date = assertDate(flagString(flags, "date"), "--date");
    const p = getDayPeriod(timezone, date);
    return { type, startUnix: p.startUnix, endUnix: p.endUnix, label: date };
  }

  if (type === "weekly") {
    const date = flagString(flags, "date");
    const anchor = date ? new Date(`${assertDate(date, "--date")}T12:00:00Z`) : now;
    const p = getWeekPeriod(timezone, anchor);
    return {
      type,
      startUnix: p.startUnix,
      endUnix: p.endUnix,
      label: `${fmtDate(p.startUnix, timezone)}..${fmtDate(p.endUnix, timezone)}`,
    };
  }

  const month = assertMonth(flagString(flags, "month"));
  const p = getMonthPeriod(timezone, month, now);
  return {
    type,
    startUnix: p.startUnix,
    endUnix: p.endUnix,
    label: `${p.startDate}..${p.endDate}`,
  };
}

export function findReportByPeriod(db: Database, period: ReportPeriod): ReportRow | null {
  return (
    db
      .query<ReportRow, [string, number, number]>(
        "SELECT id, type, period_start, period_end, content, sent_at FROM reports WHERE type = ? AND period_start = ? AND period_end = ? LIMIT 1"
      )
      .get(period.type, period.startUnix, period.endUnix) ?? null
  );
}

function selectDeliveries(db: Database, reportId: number, cardIndex?: number): DeliveryRow[] {
  if (cardIndex !== undefined) {
    return db
      .query<DeliveryRow, [number, number]>(
        "SELECT id, report_id, card_index, content, status, lark_message_id, sent_at FROM report_deliveries WHERE report_id = ? AND card_index = ? ORDER BY card_index"
      )
      .all(reportId, cardIndex);
  }
  return db
    .query<DeliveryRow, [number]>(
      "SELECT id, report_id, card_index, content, status, lark_message_id, sent_at FROM report_deliveries WHERE report_id = ? ORDER BY card_index"
    )
    .all(reportId);
}

export function markDeliveryStatus(db: Database, options: MarkDeliveryOptions): MarkDeliveryResult {
  const before = selectDeliveries(db, options.reportId, options.cardIndex);
  if (!options.yes || before.length === 0) {
    return { mutated: false, before, after: before };
  }

  if (options.cardIndex !== undefined) {
    db.run(
      "UPDATE report_deliveries SET status = ?, lark_message_id = CASE WHEN ? = 'pending' THEN NULL ELSE lark_message_id END, sent_at = CASE WHEN ? = 'pending' THEN NULL ELSE sent_at END WHERE report_id = ? AND card_index = ?",
      [options.status, options.status, options.status, options.reportId, options.cardIndex]
    );
  } else {
    db.run(
      "UPDATE report_deliveries SET status = ?, lark_message_id = CASE WHEN ? = 'pending' THEN NULL ELSE lark_message_id END, sent_at = CASE WHEN ? = 'pending' THEN NULL ELSE sent_at END WHERE report_id = ?",
      [options.status, options.status, options.status, options.reportId]
    );
  }

  if (options.status !== "sent") {
    db.run("UPDATE reports SET sent_at = NULL WHERE id = ?", [options.reportId]);
  }

  const after = selectDeliveries(db, options.reportId, options.cardIndex);
  return { mutated: true, before, after };
}

export function parseRedispatchMode(flags: Record<string, FlagValue>): RedispatchMode {
  if (flags["dispatch-only"]) {
    throw new Error("Use --mode dispatch-only instead of --dispatch-only.");
  }
  if (flags["report-only"]) {
    throw new Error("Use --mode report-only instead of --report-only.");
  }
  const mode = flags.mode ?? "full";
  if (mode !== "full" && mode !== "report-only" && mode !== "dispatch-only") {
    throw new Error(`Invalid --mode "${String(mode)}". Expected full, report-only, or dispatch-only.`);
  }
  return mode;
}

function parseReportContentCards(reportId: number, content: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Report #${reportId} content is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const cards = Array.isArray(parsed) ? parsed : parsed === null ? [] : [parsed];
  return cards.map((card, idx) => {
    if (!card || typeof card !== "object" || Array.isArray(card)) {
      throw new Error(`Report #${reportId} card_${idx} is not a Lark card object`);
    }
    return JSON.stringify(card);
  });
}

function deliverySummary(rows: DeliveryRow[]): Array<Record<string, unknown>> {
  return rows.map((row) => ({
    id: row.id,
    reportId: row.report_id,
    cardIndex: row.card_index,
    status: row.status,
    larkMessageId: row.lark_message_id,
    sentAt: row.sent_at,
    contentBytes: Buffer.byteLength(row.content, "utf-8"),
  }));
}

function refreshDeliveriesFromReportContent(db: Database, reportId: number): boolean {
  const row = db.query<{ content: string }, [number]>("SELECT content FROM reports WHERE id = ?").get(reportId);
  if (!row) throw new Error(`Report #${reportId} was not found`);

  const cardJson = parseReportContentCards(reportId, row.content);
  if (cardJson.length === 0) {
    db.run("DELETE FROM report_deliveries WHERE report_id = ?", [reportId]);
    return true;
  }

  for (let i = 0; i < cardJson.length; i++) {
    const content = cardJson[i]!;
    db.run(
      `INSERT INTO report_deliveries (report_id, card_index, content)
       VALUES (?, ?, ?)
       ON CONFLICT(report_id, card_index)
       DO UPDATE SET content = excluded.content`,
      [reportId, i, content]
    );
  }
  db.run("DELETE FROM report_deliveries WHERE report_id = ? AND card_index >= ?", [reportId, cardJson.length]);
  return true;
}

export function prepareRedispatch(
  db: Database,
  options: RedispatchPrepareOptions
): RedispatchPrepareResult {
  const before = selectDeliveries(db, options.reportId);
  if (!options.yes) {
    return { mutated: false, before, after: before, refreshed: false };
  }

  const refreshed = options.mode !== "dispatch-only"
    ? refreshDeliveriesFromReportContent(db, options.reportId)
    : false;

  db.run(
    "UPDATE report_deliveries SET status = 'pending', lark_message_id = NULL, sent_at = NULL WHERE report_id = ?",
    [options.reportId]
  );
  db.run("UPDATE reports SET sent_at = NULL WHERE id = ?", [options.reportId]);

  return {
    mutated: true,
    before,
    after: selectDeliveries(db, options.reportId),
    refreshed,
  };
}

async function dispatchPreparedReport(
  db: Database,
  reportId: number,
  webhookUrl: string
): Promise<RedispatchDispatchResult> {
  const pending = db
    .query<DeliveryRow, [number]>(
      "SELECT id, report_id, card_index, content, status, lark_message_id, sent_at FROM report_deliveries WHERE report_id = ? AND status = 'pending' ORDER BY card_index"
    )
    .all(reportId);
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  for (const delivery of pending) {
    let card: object;
    try {
      const parsed = JSON.parse(delivery.content) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("card content is not an object");
      }
      card = parsed;
    } catch (err) {
      const msg = `Delivery ${delivery.id}: failed to parse card content: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      failed++;
      continue;
    }

    try {
      const result = await sendCard(webhookUrl, card);
      const now = Math.floor(Date.now() / 1000);
      if (result.code === 0) {
        db.run(
          "UPDATE report_deliveries SET status = 'sent', lark_message_id = ?, sent_at = ? WHERE id = ?",
          [result.data?.message_id ?? null, now, delivery.id]
        );
        sent++;
      } else {
        const msg = `Delivery ${delivery.id}: Lark error code=${result.code} msg=${result.msg}`;
        errors.push(msg);
        db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
        failed++;
      }
    } catch (err) {
      const msg = `Delivery ${delivery.id}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(msg);
      db.run("UPDATE report_deliveries SET status = 'failed' WHERE id = ?", [delivery.id]);
      failed++;
    }
  }

  const remaining = db
    .query<{ count: number }, [number]>(
      "SELECT COUNT(*) as count FROM report_deliveries WHERE report_id = ? AND status != 'sent'"
    )
    .get(reportId);
  if ((remaining?.count ?? 0) === 0 && pending.length > 0) {
    db.run("UPDATE reports SET sent_at = ? WHERE id = ?", [Math.floor(Date.now() / 1000), reportId]);
  }

  return { sent, failed, errors };
}

async function runDailyCollectAnalyzeForPeriod(
  period: ReportPeriod,
  timezone: string
): Promise<string[]> {
  const [{ execute: collectExecute }, { execute: analyzeExecute }, fetcher, diffFetcher] =
    await Promise.all([
      import("../../pipeline/stages/collect"),
      import("../../pipeline/stages/analyze"),
      import("../../extensions/github-collector/fetcher"),
      import("../../extensions/github-collector/diff-fetcher"),
    ]);

  const ctx = {
    stageResults: new Map(),
    reportMode: "daily" as const,
    timezone,
  };
  const errors: string[] = [];

  const collectResult = await collectExecute(
    ctx,
    {
      fetchMergedPRs: fetcher.fetchMergedPRs,
      fetchRepoMetadata: fetcher.fetchRepoMetadata,
      fetchPRStats: fetcher.fetchPRStats,
      fetchAndStoreDiff: diffFetcher.fetchAndStoreDiff,
    },
    {
      dateRangeOverride: { startUnix: period.startUnix, endUnix: period.endUnix },
      skipSyncUpdate: true,
    }
  );
  ctx.stageResults.set("collect", collectResult);
  if (!collectResult.success) errors.push(...collectResult.errors);

  const analyzeResult = await analyzeExecute(ctx, {
    dateRange: { startUnix: period.startUnix, endUnix: period.endUnix },
  });
  ctx.stageResults.set("analyze", analyzeResult);
  if (!analyzeResult.success) errors.push(...analyzeResult.errors);

  return errors;
}

async function regenerateDailyReportFromAnalyses(
  db: Database,
  period: ReportPeriod,
  timezone: string,
  promptPath?: string
): Promise<ReportRow> {
  const promptReport = await generateDailyPromptReportForPeriod(db, timezone, period.startUnix, period.endUnix, {
    ...(promptPath ? { promptPath } : {}),
  });
  const dailyData = buildDailyReportForPeriod(period.startUnix, period.endUnix);
  const card = buildDailyPromptCard({
    date: promptReport.input.period.date,
    markdown: promptReport.markdown,
    totalPrs: promptReport.input.activitySummary.totalPrs,
    projectCount: promptReport.input.activitySummary.projectCount,
    directionalShiftCount: promptReport.input.activitySummary.directionalShiftCount,
    notableCount: promptReport.input.activitySummary.notableCount,
    routineCount: promptReport.input.activitySummary.routineCount,
    projects: promptReport.input.projects,
  });
  const cardContent = JSON.stringify(card);
  const projectIds = JSON.stringify(promptReport.input.projects.map((g) => g.projectId));
  const completeness = JSON.stringify({
    source: "cli-redispatch",
    prompt: promptReport.promptName,
    usage: promptReport.usage,
  });

  db.run(
    `INSERT INTO reports (type, period_start, period_end, project_ids, content, completeness, digest_json)
     VALUES ('daily', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(type, period_start, period_end)
     DO UPDATE SET content = excluded.content,
                   completeness = excluded.completeness,
                   project_ids = excluded.project_ids,
                   digest_json = excluded.digest_json`,
    [
      period.startUnix,
      period.endUnix,
      projectIds,
      cardContent,
      completeness,
      JSON.stringify(dailyData.digest),
    ]
  );

  const report = findReportByPeriod(db, period);
  if (!report) throw new Error(`Daily report was not found after regeneration for ${period.label}`);
  return report;
}

function parseReportType(value: string | undefined): ReportType {
  if (value === "daily" || value === "weekly" || value === "monthly") return value;
  throw new Error(`Invalid report type "${value ?? ""}". Expected daily, weekly, or monthly.`);
}

function formatMonthLabel(month: string): string {
  const [year, rawMonth] = month.split("-");
  return `${year}年${Number(rawMonth)}月`;
}

async function writeArtifact(kind: string, label: string, card: object, prompt?: string): Promise<string> {
  const safeLabel = label.replace(/[^0-9A-Za-z._-]+/g, "-");
  const outDir = "data/reports/prompt-lab";
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${kind}-${safeLabel}-cli.json`);
  await Bun.write(outPath, JSON.stringify(card, null, 2));
  if (prompt) {
    await Bun.write(join(outDir, `${kind}-${safeLabel}-cli-prompt.md`), prompt);
  }
  return outPath;
}

async function buildReportCard(
  db: Database,
  type: ReportType,
  flags: Record<string, FlagValue>,
  timezone: string,
  send: boolean
): Promise<{ card: object; label: string; usage?: { inputTokens: number; outputTokens: number }; prompt?: string }> {
  if (type === "daily") {
    const period = resolveReportPeriod("daily", flags, timezone);
    const promptPath = flagString(flags, "prompt") ?? DEFAULT_DAILY_PROMPT_PATH;
    if (!send) {
      const input = buildDailyPromptInputForPeriod(db, timezone, period.startUnix, period.endUnix);
      const promptTemplate = await Bun.file(promptPath).text();
      const prompt = renderDailyPrompt(promptTemplate, input);
      const card = buildDailyPromptCard({
        date: input.period.date,
        markdown: `## Preview\n\nDry run preview for ${input.activitySummary.totalPrs} PRs across ${input.activitySummary.projectCount} projects.`,
        totalPrs: input.activitySummary.totalPrs,
        projectCount: input.activitySummary.projectCount,
        directionalShiftCount: input.activitySummary.directionalShiftCount,
        notableCount: input.activitySummary.notableCount,
        routineCount: input.activitySummary.routineCount,
        projects: input.projects,
      });
      return { card, label: input.period.date, prompt };
    }

    const report = await generateDailyPromptReportForPeriod(db, timezone, period.startUnix, period.endUnix, {
      promptPath,
    });
    const card = buildDailyPromptCard({
      date: report.input.period.date,
      markdown: report.markdown,
      totalPrs: report.input.activitySummary.totalPrs,
      projectCount: report.input.activitySummary.projectCount,
      directionalShiftCount: report.input.activitySummary.directionalShiftCount,
      notableCount: report.input.activitySummary.notableCount,
      routineCount: report.input.activitySummary.routineCount,
      projects: report.input.projects,
    });
    return { card, label: report.input.period.date, usage: report.usage };
  }

  if (type === "weekly") {
    const date = flagString(flags, "date");
    const now = date ? new Date(`${assertDate(date, "--date")}T12:00:00Z`) : undefined;
    const result = send
      ? await generateWeeklyPromptReport(db, timezone, { now })
      : await generateWeeklyPromptReport(db, timezone, {
          now,
          generateFn: async () => ({
            text: "## Preview\n\nDry run weekly preview.",
            usage: { inputTokens: 0, outputTokens: 0 },
          }),
        });
    const dateRange = `${fmtDate(result.input.period.startUnix, timezone)}-${fmtDate(result.input.period.endUnix, timezone)}`;
    const card = buildWeeklyPromptCard({
      dateRange,
      markdown: result.markdown,
      totalPrs: result.input.activitySummary.totalPrs,
      projectCount: result.input.activitySummary.projectCount,
      dailyCoverage: {
        present: result.input.dailyDigestCoverage.present,
        missing: result.input.dailyDigestCoverage.missing,
      },
    });
    return { card, label: result.input.period.endDate, usage: result.usage };
  }

  const month = assertMonth(flagString(flags, "month"));
  const result = send
    ? await generateMonthlyPromptReport(db, timezone, { month })
    : await generateMonthlyPromptReport(db, timezone, {
        month,
        generateFn: async () => ({
          text: "## Preview\n\nDry run monthly preview.",
          usage: { inputTokens: 0, outputTokens: 0 },
        }),
      });
  const dailyCov = result.input.coverage.dailyReports;
  const card = buildMonthlyPromptCard({
    monthLabel: formatMonthLabel(result.input.period.month),
    periodLabel: result.input.period.label,
    markdown: result.markdown,
    totalPrs: result.input.activitySummary.totalPrs,
    projectCount: result.input.activitySummary.projectCount,
    isPartial: result.input.period.isPartial,
    dailyCoverage: {
      present: dailyCov.present,
      missing: dailyCov.missing,
      total: dailyCov.present + dailyCov.nullDigest + dailyCov.missing,
    },
  });
  return { card, label: result.input.period.month, usage: result.usage };
}

export async function reportSendCommand(
  args: string[],
  flags: Record<string, FlagValue>,
  global: GlobalFlags = { json: false, verbose: false }
): Promise<number> {
  const type = parseReportType(args[0]);
  const yes = flagBool(flags, "yes");
  const db = getDb();
  const timezone = global.timezone ?? getSettings().schedule.timezone;
  const webhookUrl = getSettings().lark.webhookUrl;
  if (yes && !webhookUrl) {
    console.error("[report send] LARK_WEBHOOK_URL is not set.");
    return 1;
  }
  const built = await buildReportCard(db, type, flags, timezone, yes);
  const outPath = await writeArtifact(type, built.label, built.card, built.prompt);
  const bytes = Buffer.byteLength(JSON.stringify(built.card), "utf-8");
  console.log(`[report send] ${type} ${built.label}: ${bytes} bytes`);
  console.log(`[report send] Saved to ${outPath}`);
  if (built.usage) {
    console.log(`[report send] Usage: input=${built.usage.inputTokens}, output=${built.usage.outputTokens}`);
  }

  if (!yes) {
    console.log("[report send] Preview only. Re-run with --yes to send to Lark.");
    return 0;
  }

  const targetWebhookUrl = webhookUrl;
  if (!targetWebhookUrl) {
    console.error("[report send] LARK_WEBHOOK_URL is not set.");
    return 1;
  }
  const resp = await sendCard(targetWebhookUrl, built.card);
  if (resp.code === 0) {
    console.log(`[report send] Sent to Lark (message_id=${resp.data?.message_id ?? "n/a"})`);
    return 0;
  }
  console.error(`[report send] Lark error: ${JSON.stringify(resp)}`);
  return 1;
}

export async function markDeliveryCommand(
  args: string[],
  flags: Record<string, FlagValue>,
  global: GlobalFlags = { json: false, verbose: false }
): Promise<number> {
  const type = parseReportType(args[0]);
  const timezone = global.timezone ?? getSettings().schedule.timezone;
  const period = resolveReportPeriod(type, flags, timezone);
  const db = getDb();
  const report = findReportByPeriod(db, period);
  if (!report) {
    console.error(`[report mark-delivery] No ${type} report found for ${period.label}.`);
    return 1;
  }
  const rawStatus = flagString(flags, "status");
  if (rawStatus !== "pending" && rawStatus !== "sent" && rawStatus !== "failed") {
    throw new Error("--status must be pending, sent, or failed");
  }
  const cardIndexRaw = flagString(flags, "card-index");
  let cardIndex: number | undefined;
  if (cardIndexRaw !== undefined) {
    const parsed = Number(cardIndexRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("--card-index must be a non-negative integer");
    }
    cardIndex = parsed;
  }
  const result = markDeliveryStatus(db, {
    reportId: report.id,
    status: rawStatus,
    cardIndex,
    yes: flagBool(flags, "yes"),
  });
  console.log(`[report mark-delivery] Report #${report.id} ${type} ${period.label}`);
  console.log(`[report mark-delivery] Before: ${JSON.stringify(result.before)}`);
  console.log(`[report mark-delivery] After: ${JSON.stringify(result.after)}`);
  if (!result.mutated) {
    console.log("[report mark-delivery] Dry run. Re-run with --yes to mutate.");
  }
  return 0;
}

export async function redispatchCommand(
  args: string[],
  flags: Record<string, FlagValue>,
  global: GlobalFlags = { json: false, verbose: false }
): Promise<number> {
  const type = parseReportType(args[0]);
  if (type !== "daily") {
    throw new Error("report redispatch currently supports daily only.");
  }
  const mode = parseRedispatchMode(flags);
  const db = getDb();
  const timezone = global.timezone ?? getSettings().schedule.timezone;
  const period = resolveReportPeriod("daily", flags, timezone);
  const report = findReportByPeriod(db, period);
  if (!report) {
    console.error(`[report redispatch] No daily report found for ${period.label}.`);
    return 1;
  }
  const yes = flagBool(flags, "yes");
  if (!yes) {
    const deliveries = selectDeliveries(db, report.id);
    console.log(`[report redispatch] Target report #${report.id}, mode=${mode}, period=${period.label}`);
    console.log(`[report redispatch] Deliveries: ${JSON.stringify(deliverySummary(deliveries))}`);
    console.log("[report redispatch] Dry run. Re-run with --yes to reset and send scoped deliveries.");
    return 0;
  }
  const webhookUrl = getSettings().lark.webhookUrl;
  if (!webhookUrl) {
    console.error("[report redispatch] LARK_WEBHOOK_URL is not set.");
    return 1;
  }

  let activeReport = report;
  if (mode === "full") {
    const errors = await runDailyCollectAnalyzeForPeriod(period, timezone);
    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[report redispatch] ${error}`);
      }
      return 1;
    }
  }

  if (mode !== "dispatch-only") {
    activeReport = await regenerateDailyReportFromAnalyses(
      db,
      period,
      timezone,
      flagString(flags, "prompt")
    );
  }

  const prepared = prepareRedispatch(db, { reportId: activeReport.id, mode, yes });

  console.log(`[report redispatch] Target report #${activeReport.id}, mode=${mode}, period=${period.label}`);
  console.log(`[report redispatch] Before: ${JSON.stringify(deliverySummary(prepared.before))}`);
  console.log(`[report redispatch] After: ${JSON.stringify(deliverySummary(prepared.after))}`);

  if (mode !== "dispatch-only" && prepared.refreshed) {
    console.log("[report redispatch] Refreshed delivery content from reports.content.");
  }

  const result = await dispatchPreparedReport(db, activeReport.id, webhookUrl);
  console.log(`[report redispatch] Dispatch result: sent=${result.sent}, failed=${result.failed}`);
  for (const error of result.errors) {
    console.error(`[report redispatch] ${error}`);
  }
  return result.failed > 0 ? 1 : 0;
}
