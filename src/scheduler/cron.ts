import { Cron } from "croner";
import { getSettings } from "../config/settings";
import { runPipeline } from "../pipeline/runner";
import { stage as collect } from "../pipeline/stages/collect";
import { stage as analyze } from "../pipeline/stages/analyze";
import { stage as report } from "../pipeline/stages/report";
import { stage as dispatch } from "../pipeline/stages/dispatch";

const FULL_PIPELINE_STAGES = [collect, analyze, report, dispatch];
const REPORT_ONLY_STAGES = [report, dispatch];

function validateTimezone(tz: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new Error(
      `Invalid IANA timezone "${tz}" in settings.schedule.timezone. ` +
      `Use a valid IANA timezone identifier (e.g. "Asia/Shanghai", "UTC").`
    );
  }
}

export function registerScheduler(): void {
  const { schedule } = getSettings();
  const timezone = schedule.timezone;
  validateTimezone(timezone);

  new Cron(schedule.dailyCron, { timezone }, async () => {
    console.log("[Scheduler] Daily pipeline triggered");
    await runPipeline(FULL_PIPELINE_STAGES, { timezone });
  });

  new Cron(schedule.weeklyCron, { timezone }, async () => {
    console.log("[Scheduler] Weekly pipeline triggered");
    await runPipeline(FULL_PIPELINE_STAGES, { reportMode: "weekly", timezone });
  });

  new Cron(schedule.monthlyCron, { timezone }, async () => {
    console.log("[Scheduler] Monthly pipeline triggered");
    await runPipeline(REPORT_ONLY_STAGES, { reportMode: "monthly", timezone, skipDailyReport: true });
  });

  console.log(
    `[Scheduler] Registered daily (${schedule.dailyCron}), weekly (${schedule.weeklyCron}), and monthly (${schedule.monthlyCron}) jobs, timezone=${timezone}`
  );
}

export async function runNow(): Promise<void> {
  const { schedule } = getSettings();
  console.log("[Scheduler] Manual pipeline trigger");
  await runPipeline(FULL_PIPELINE_STAGES, { timezone: schedule.timezone });
}
