import { exportAnalyses } from "../../utils/audit-export";
import { flagString, type FlagValue } from "../args";

function parseDate(value: string | undefined, flag: string): Date {
  if (!value) throw new Error(`${flag} is required`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid ${flag} "${value}". Expected ISO date.`);
  }
  return date;
}

export async function exportAuditCommand(flags: Record<string, FlagValue>): Promise<number> {
  const since = parseDate(flagString(flags, "since"), "--since");
  const until = parseDate(flagString(flags, "until"), "--until");
  const output = flagString(flags, "output");
  if (!output) throw new Error("--output is required");
  const count = await exportAnalyses(since, until, output);
  console.log(`Exported ${count} record(s) to ${output}`);
  return 0;
}
