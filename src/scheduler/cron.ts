import { Cron } from "croner";
import { getSettings } from "../config/settings";
import { runPipeline } from "../pipeline/runner";
import { stage as collect } from "../pipeline/stages/collect";
import { stage as analyze } from "../pipeline/stages/analyze";
import { stage as report } from "../pipeline/stages/report";
import { stage as dispatch } from "../pipeline/stages/dispatch";

const STAGES = [collect, analyze, report, dispatch];

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
    await runPipeline(STAGES, { timezone });
  });

  new Cron(schedule.weeklyCron, { timezone }, async () => {
    console.log("[Scheduler] Weekly pipeline triggered");
    await runPipeline(STAGES, { reportMode: "weekly", timezone });
  });

  console.log(
    `[Scheduler] Registered daily (${schedule.dailyCron}) and weekly (${schedule.weeklyCron}) jobs, timezone=${timezone}`
  );
}

export async function runNow(): Promise<void> {
  const { schedule } = getSettings();
  console.log("[Scheduler] Manual pipeline trigger");
  await runPipeline(STAGES, { timezone: schedule.timezone });
}
