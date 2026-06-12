import { closeDb, setDbPathForProcess } from "../storage/db";
import { parseCliArgs, resolveCommand, type CommandDefinition } from "./args";
import { runCommand } from "./commands/run";
import { reportSendCommand, markDeliveryCommand, redispatchCommand } from "./commands/report";
import { backfillCommand } from "./commands/backfill";
import { dbStatusCommand } from "./commands/db";
import { configShowCommand } from "./commands/config";
import { budgetCommand } from "./commands/budget";
import { exportAuditCommand } from "./commands/export";
import { projectListCommand } from "./commands/project";
import { impactCheckRequeueCommand } from "./commands/impact-check";

interface CliCommand extends CommandDefinition {
  run: (rest: string[], parsed: ReturnType<typeof parseCliArgs>) => Promise<number>;
}

const COMMANDS: CliCommand[] = [
  {
    path: ["run"],
    description: "Run the pipeline for daily, weekly, or monthly report modes.",
    run: (rest, parsed) => runCommand(rest, parsed.flags, parsed.global),
  },
  {
    path: ["report", "send"],
    description: "Preview by default, or send a generated daily/weekly/monthly report with --yes.",
    run: (rest, parsed) => reportSendCommand(rest, parsed.flags, parsed.global),
  },
  {
    path: ["report", "redispatch"],
    description: "Re-send an existing persisted daily report delivery.",
    run: (rest, parsed) => redispatchCommand(rest, parsed.flags, parsed.global),
  },
  {
    path: ["report", "mark-delivery"],
    description: "Safely update delivery status for a targeted report.",
    run: (rest, parsed) => markDeliveryCommand(rest, parsed.flags, parsed.global),
  },
  {
    path: ["backfill"],
    description: "Backfill historical collect/analyze/daily report data.",
    run: (_rest, parsed) => backfillCommand(parsed.flags, parsed.global),
  },
  {
    path: ["db", "status"],
    description: "Print read-only database health and report status.",
    run: (_rest, parsed) => dbStatusCommand(parsed.flags, parsed.global),
  },
  {
    path: ["config", "show"],
    description: "Print sanitized settings or project configuration.",
    run: (rest, parsed) => configShowCommand(rest, parsed.global),
  },
  {
    path: ["budget"],
    description: "Print current or historical monthly LLM budget usage.",
    run: (_rest, parsed) => budgetCommand(parsed.flags, parsed.global),
  },
  {
    path: ["export", "audit"],
    description: "Export analysis audit JSONL.",
    run: (_rest, parsed) => exportAuditCommand(parsed.flags),
  },
  {
    path: ["project", "list"],
    description: "List tracked projects and lightweight collection health.",
    run: (_rest, parsed) => projectListCommand(parsed.flags, parsed.global),
  },
  {
    path: ["impact-check", "requeue"],
    description: "Requeue an impact check by id or bulk-reset skipped_budget rows. Dry-run by default; use --yes to write.",
    run: (rest, parsed) => impactCheckRequeueCommand(rest, parsed.flags, parsed.global),
  },
];

function printHelp(): void {
  console.log(`Counterpart Monitor CLI

Usage:
  bun run cli -- <command> [options]

Commands:`);
  for (const command of COMMANDS) {
    console.log(`  ${command.path.join(" ").padEnd(22)} ${command.description}`);
  }
  console.log(`
Global flags:
  --json
  --verbose, -v
  --timezone <tz>
  --db <path>

Examples:
  bun run cli -- run daily --no-dispatch
  bun run cli -- run monthly --month 2026-06 --no-dispatch
  bun run cli -- report send monthly --month 2026-06
  bun run cli -- db status --date 2026-06-09
  bun run cli -- report mark-delivery daily --date 2026-06-09 --status pending
`);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (
    parsed.tokens.length === 0 ||
    parsed.tokens.includes("help") ||
    parsed.tokens.includes("--help") ||
    parsed.flags.help === true
  ) {
    printHelp();
    return 0;
  }
  if (parsed.global.dbPath) {
    setDbPathForProcess(parsed.global.dbPath);
  }

  const resolved = resolveCommand(parsed.tokens, COMMANDS);
  if (!resolved) {
    console.error(`Unknown command: ${parsed.tokens.join(" ")}`);
    printHelp();
    return 1;
  }

  return resolved.command.run(resolved.rest, parsed);
}

if (import.meta.main) {
  runCli()
    .then((code) => {
      closeDb();
      process.exit(code);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      closeDb();
      process.exit(1);
    });
}
