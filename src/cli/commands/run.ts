import { runE2E, type RunMode } from "../../e2e-run";
import { flagBool, flagString, type FlagValue, type GlobalFlags } from "../args";

type CliRunMode = Exclude<RunMode, "all">;

export interface RunCommandOptions {
  mode: CliRunMode;
  noDispatch: boolean;
  month?: string;
}

const VALID_RUN_MODES: CliRunMode[] = ["daily", "weekly", "monthly"];

function parseMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid --month "${value}". Expected YYYY-MM.`);
  const month = Number(match[2]);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid --month "${value}". Expected month 01-12.`);
  }
  return value;
}

export function parseRunArgs(
  args: string[],
  flags: Record<string, FlagValue> = {}
): RunCommandOptions {
  const rawMode = args[0] ?? "daily";
  if (!VALID_RUN_MODES.includes(rawMode as CliRunMode)) {
    throw new Error(`Invalid run mode "${rawMode}". Expected daily, weekly, or monthly.`);
  }

  let noDispatch = flagBool(flags, "no-dispatch");
  const flagMonth = flagString(flags, "month");
  let month = flagMonth ? parseMonth(flagMonth) : undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-dispatch") {
      noDispatch = true;
      continue;
    }
    if (arg === "--month") {
      const value = args[++i];
      if (!value) throw new Error("--month requires YYYY-MM");
      month = parseMonth(value);
      continue;
    }
    throw new Error(`Unknown run argument: ${arg}`);
  }

  return month ? { mode: rawMode as CliRunMode, noDispatch, month } : { mode: rawMode as CliRunMode, noDispatch };
}

export async function runCommand(
  args: string[],
  flags: Record<string, FlagValue> = {},
  global: GlobalFlags = { json: false, verbose: false }
): Promise<number> {
  const options = parseRunArgs(args, flags);
  const argv = ["--mode", options.mode];
  if (options.noDispatch) argv.push("--no-dispatch");
  if (options.month) argv.push("--month", options.month);
  if (global.timezone) argv.push("--timezone", global.timezone);
  return runE2E(argv);
}
