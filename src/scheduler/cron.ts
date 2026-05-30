import { Cron } from "croner";
import { getSettings } from "../config/settings";
import { runPipeline } from "../pipeline/runner";
import { stage as collect } from "../pipeline/stages/collect";
import { stage as analyze } from "../pipeline/stages/analyze";
import { stage as report } from "../pipeline/stages/report";
import { stage as dispatch } from "../pipeline/stages/dispatch";

const STAGES = [collect, analyze, report, dispatch];

export function registerScheduler(): void {
  const { schedule } = getSettings();

  new Cron(schedule.dailyCron, async () => {
    console.log("[Scheduler] Daily pipeline triggered");
    await runPipeline(STAGES);
  });

  new Cron(schedule.weeklyCron, async () => {
    console.log("[Scheduler] Weekly pipeline triggered");
    await runPipeline(STAGES, { isWeeklyRun: true });
  });

  console.log(
    `[Scheduler] Registered daily (${schedule.dailyCron}) and weekly (${schedule.weeklyCron}) jobs`
  );
}

export async function runNow(): Promise<void> {
  console.log("[Scheduler] Manual pipeline trigger");
  await runPipeline(STAGES);
}
