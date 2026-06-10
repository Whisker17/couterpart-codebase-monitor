export interface GlobalFlags {
  json: boolean;
  verbose: boolean;
  timezone?: string;
  dbPath?: string;
}

export type FlagValue = string | boolean;

export interface ParsedCliArgs {
  global: GlobalFlags;
  tokens: string[];
  flags: Record<string, FlagValue>;
}

export interface CommandDefinition {
  path: string[];
  description: string;
}

export interface ResolvedCommand<T extends CommandDefinition = CommandDefinition> {
  command: T;
  rest: string[];
}

const GLOBAL_VALUE_FLAGS: Record<string, keyof GlobalFlags> = {
  timezone: "timezone",
  db: "dbPath",
};

function normalizeFlagName(raw: string): string {
  return raw.replace(/^-+/, "");
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const global: GlobalFlags = { json: false, verbose: false };
  const tokens: string[] = [];
  const flags: Record<string, FlagValue> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg === "--json") {
      global.json = true;
      continue;
    }
    if (arg === "--verbose" || arg === "-v") {
      global.verbose = true;
      continue;
    }
    if (arg === "--timezone" || arg === "--db") {
      const key = GLOBAL_VALUE_FLAGS[normalizeFlagName(arg)]!;
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      global[key] = value as never;
      continue;
    }

    if (arg.startsWith("--")) {
      const name = normalizeFlagName(arg);
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
      continue;
    }

    tokens.push(arg);
  }

  return { global, tokens, flags };
}

export function resolveCommand<T extends CommandDefinition>(
  tokens: string[],
  commands: T[]
): ResolvedCommand<T> | null {
  const sorted = [...commands].sort((a, b) => b.path.length - a.path.length);
  for (const command of sorted) {
    const matches = command.path.every((part, idx) => tokens[idx] === part);
    if (matches) {
      return { command, rest: tokens.slice(command.path.length) };
    }
  }
  return null;
}

export function flagString(
  flags: Record<string, FlagValue>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(flags: Record<string, FlagValue>, name: string): boolean {
  return flags[name] === true;
}
