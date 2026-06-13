import { realpathSync, existsSync, readFileSync } from "fs";
import { resolve, isAbsolute } from "path";
import { tool, zodSchema } from "ai";
import { z } from "zod";

const GREP_TIMEOUT_MS = 30_000;
const MAX_GREP_MATCHES = 50;
const MAX_READ_LINES = 250;
const MAX_OUTPUT_BYTES = 8 * 1024; // 8KB
const MAX_OUTPUT_LINES = 200;

// Strict allowlist: only inert search-modifier flags may be forwarded to rg.
// rg --pre <cmd> and similar preprocessor flags are excluded to prevent RCE.
const ALLOWED_GREP_FLAGS = new Set([
  "-i", "--ignore-case",
  "-w", "--word-regexp",
  "-l", "--files-with-matches",
]);

// Exported for testing
export type RgRunner = (
  args: string[],
  timeoutMs: number
) => Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>;

let _rgRunner: RgRunner | null = null;

export function _setRgRunner(runner: RgRunner): void {
  _rgRunner = runner;
}

export function _resetRgRunner(): void {
  _rgRunner = null;
}

function getRgRunner(): RgRunner {
  return _rgRunner ?? defaultRgRunner;
}

async function defaultRgRunner(
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  let timedOut = false;
  const proc = Bun.spawn(["rg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, timeoutMs);

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }

  return { stdout, stderr, exitCode, timedOut };
}

function realpathBestEffort(p: string): string {
  // Try full realpath first; if it fails (file doesn't exist), resolve each
  // directory component step by step so symlinks in the path are followed.
  try {
    return realpathSync(p);
  } catch {
    // Walk up to find the deepest existing ancestor, resolve it, then re-append the rest
    const parts = p.split("/");
    for (let i = parts.length; i > 0; i--) {
      const partial = parts.slice(0, i).join("/") || "/";
      try {
        const realPartial = realpathSync(partial);
        const rest = parts.slice(i).join("/");
        return rest ? realPartial + "/" + rest : realPartial;
      } catch {
        continue;
      }
    }
    return p;
  }
}

export function fencePathToCloneDir(inputPath: string, cloneDir: string): string | null {
  // Resolve the clone dir itself (follow symlinks)
  let resolvedCloneDir: string;
  try {
    resolvedCloneDir = realpathSync(cloneDir);
  } catch {
    resolvedCloneDir = resolve(cloneDir);
  }

  const withSep = resolvedCloneDir.endsWith("/") ? resolvedCloneDir : resolvedCloneDir + "/";

  // Reject absolute paths that aren't under clone dir before resolving
  if (isAbsolute(inputPath)) {
    const real = realpathBestEffort(resolve(inputPath));
    if (!real.startsWith(withSep) && real !== resolvedCloneDir) {
      return null;
    }
    return real;
  }

  // For relative paths, resolve against clone dir, then resolve symlinks
  const joined = resolve(resolvedCloneDir, inputPath);
  const real = realpathBestEffort(joined);

  if (!real.startsWith(withSep) && real !== resolvedCloneDir) {
    return null;
  }

  return real;
}

function capOutput(text: string): string {
  const lines = text.split("\n");
  let truncatedLines = false;
  let truncatedBytes = false;

  let result = lines;
  if (lines.length > MAX_OUTPUT_LINES) {
    result = lines.slice(0, MAX_OUTPUT_LINES);
    truncatedLines = true;
  }

  let joined = result.join("\n");
  if (Buffer.byteLength(joined, "utf8") > MAX_OUTPUT_BYTES) {
    // Truncate to 8KB
    const buf = Buffer.from(joined, "utf8").slice(0, MAX_OUTPUT_BYTES);
    joined = buf.toString("utf8");
    // Trim to last complete line
    const lastNewline = joined.lastIndexOf("\n");
    if (lastNewline > 0) joined = joined.slice(0, lastNewline);
    truncatedBytes = true;
  }

  const notices: string[] = [];
  if (truncatedLines) notices.push(`[truncated: output exceeded ${MAX_OUTPUT_LINES} lines]`);
  if (truncatedBytes) notices.push(`[truncated: output exceeded ${MAX_OUTPUT_BYTES / 1024}KB]`);
  if (notices.length > 0) joined += "\n" + notices.join(" ");

  return joined;
}

const grepParamSchema = z.object({
  pattern: z.string().describe("Regex or literal pattern to search for"),
  path: z
    .string()
    .optional()
    .describe("Optional subdirectory or file path within the repo (relative)"),
  flags: z
    .array(z.string())
    .optional()
    .describe(
      "Optional search modifiers. Allowed values: -i / --ignore-case, -w / --word-regexp, -l / --files-with-matches"
    ),
});

const readParamSchema = z.object({
  path: z.string().describe("Relative path to the file within the repository"),
  start_line: z
    .number()
    .optional()
    .describe("Start line number (1-indexed, inclusive). Defaults to 1."),
  end_line: z
    .number()
    .optional()
    .describe(
      `End line number (1-indexed, inclusive). Defaults to start_line + ${MAX_READ_LINES - 1}.`
    ),
});

export function makeAgentTools(cloneDir: string) {
  const grepRepo = tool({
    description:
      "Search the fork repository using ripgrep. Returns matching lines with file paths and line numbers. Limited to 50 matches.",
    inputSchema: zodSchema(grepParamSchema),
    execute: async ({
      pattern,
      path,
      flags,
    }: z.infer<typeof grepParamSchema>) => {
      // Build argv array — no shell interpolation
      const args: string[] = [
        "--line-number",
        "--color=never",
        "-g",
        "!.codegraph",
        "--max-count",
        String(MAX_GREP_MATCHES),
      ];

      // Validate flags against allowlist before appending to subprocess args.
      // This prevents arbitrary flag injection (e.g. --pre <cmd>) that could
      // execute attacker-controlled code for each matched file.
      if (flags && flags.length > 0) {
        for (const flag of flags) {
          if (!ALLOWED_GREP_FLAGS.has(flag)) {
            return {
              error: `Flag not allowed: '${flag}'. Allowed flags: ${[...ALLOWED_GREP_FLAGS].join(", ")}`,
            };
          }
          args.push(flag);
        }
      }

      args.push(pattern);

      // Validate and fence the path
      if (path !== undefined && path !== "") {
        const fenced = fencePathToCloneDir(path, cloneDir);
        if (fenced === null) {
          return {
            error: `Path rejected: '${path}' is outside the clone directory. Use relative paths within the repository.`,
          };
        }
        args.push(fenced);
      } else {
        args.push(cloneDir);
      }

      const runner = getRgRunner();
      const result = await runner(args, GREP_TIMEOUT_MS);

      if (result.timedOut) {
        return {
          error: `grep_repo timed out after ${GREP_TIMEOUT_MS / 1000}s. The search pattern may be too broad or the repository too large. Try a more specific pattern.`,
        };
      }

      // rg exit code 1 = no matches (not an error)
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return {
          error: `grep_repo failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
        };
      }

      if (!result.stdout.trim()) {
        return { matches: "", notice: "No matches found." };
      }

      return { matches: capOutput(result.stdout) };
    },
  });

  const readFile = tool({
    description:
      "Read a file from the fork repository with optional line range. Returns file content with line numbers.",
    inputSchema: zodSchema(readParamSchema),
    execute: async ({
      path,
      start_line,
      end_line,
    }: z.infer<typeof readParamSchema>) => {
      const fenced = fencePathToCloneDir(path, cloneDir);
      if (fenced === null) {
        return {
          error: `Path rejected: '${path}' is outside the clone directory. Use relative paths within the repository.`,
        };
      }

      if (!existsSync(fenced)) {
        return { error: `File not found: '${path}'` };
      }

      let content: string;
      try {
        content = readFileSync(fenced, "utf-8");
      } catch (err) {
        return { error: `Failed to read file '${path}': ${err instanceof Error ? err.message : String(err)}` };
      }

      const allLines = content.split("\n");
      const totalLines = allLines.length;

      const start = Math.max(1, start_line ?? 1);
      const end = Math.min(totalLines, end_line ?? start + MAX_READ_LINES - 1);
      const clampedEnd = Math.min(end, start + MAX_READ_LINES - 1);

      const selectedLines = allLines.slice(start - 1, clampedEnd);

      // Add line numbers
      const numbered = selectedLines
        .map((line, i) => `${start + i}: ${line}`)
        .join("\n");

      const notices: string[] = [];
      if (clampedEnd < end) {
        notices.push(
          `[truncated: showing lines ${start}-${clampedEnd} of ${totalLines}; max ${MAX_READ_LINES} lines per call]`
        );
      } else if (clampedEnd < totalLines) {
        notices.push(`[showing lines ${start}-${clampedEnd} of ${totalLines} total]`);
      }

      const output = notices.length > 0 ? numbered + "\n" + notices.join(" ") : numbered;
      return { content: capOutput(output), path, lines: `${start}-${clampedEnd}`, totalLines };
    },
  });

  return { grep_repo: grepRepo, read_file: readFile };
}
