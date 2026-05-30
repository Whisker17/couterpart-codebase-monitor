export interface FileDiff {
  path: string;
  content: string;
  lineCount: number;
  tier: 0 | 1 | 2 | 3 | 4;
}

export interface TruncatedDiff {
  content: string;
  fileManifest: string;
  includedFiles: number;
  totalFiles: number;
  truncated: boolean;
}

// Patterns for files to skip entirely (tier 0)
const SKIP_PATTERNS = [
  /package-lock\.json$/,
  /yarn\.lock$/,
  /pnpm-lock\.yaml$/,
  /bun\.lockb$/,
  /\.lock$/,
  /generated\./i,
  /\.pb\.go$/,
  /\.pb\.ts$/,
  /\.min\.js$/,
  /\.min\.css$/,
  /dist\//,
  /build\//,
  /\.png$/,
  /\.jpg$/,
  /\.jpeg$/,
  /\.gif$/,
  /\.ico$/,
  /\.svg$/,
  /\.woff/,
  /\.ttf$/,
  /\.eot$/,
];

// Tier 1: high-signal files
const TIER1_PATTERNS = [
  /^package\.json$/,
  /^Dockerfile/,
  /docker-compose/,
  /\.proto$/,
  /\.github\//,
  /\.circleci\//,
  /Jenkinsfile/,
  /migrations?\//,
  /migration\./,
  /k8s\//,
  /kubernetes\//,
  /helm\//,
  /deploy\//,
  /infra\//,
];

// Tier 3: test files
const TIER3_PATTERNS = [
  /\.test\.[tj]sx?$/,
  /\.spec\.[tj]sx?$/,
  /__tests__\//,
  /test\//,
  /tests\//,
  /_test\.go$/,
];

// Tier 4: docs/config
const TIER4_PATTERNS = [
  /\.md$/,
  /\.txt$/,
  /\.rst$/,
  /README/i,
  /CHANGELOG/i,
  /\.json$/,
  /\.yaml$/,
  /\.yml$/,
  /\.toml$/,
  /\.ini$/,
  /\.cfg$/,
  /\.conf$/,
];

function getFileTier(path: string): 0 | 1 | 2 | 3 | 4 {
  if (SKIP_PATTERNS.some((p) => p.test(path))) return 0;
  if (TIER1_PATTERNS.some((p) => p.test(path))) return 1;
  if (TIER3_PATTERNS.some((p) => p.test(path))) return 3;
  if (TIER4_PATTERNS.some((p) => p.test(path))) return 4;
  return 2;
}

// Rough token estimate: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function parseFileDiffs(rawDiff: string): FileDiff[] {
  const files: FileDiff[] = [];
  // Split on "diff --git" boundaries
  const chunks = rawDiff.split(/^(?=diff --git )/m).filter((c) => c.trim());

  for (const chunk of chunks) {
    const headerMatch = chunk.match(/^diff --git a\/(.*?) b\/(.*?)$/m);
    const path = headerMatch ? (headerMatch[2] ?? "unknown") : "unknown";
    const tier = getFileTier(path);
    const lineCount = chunk.split("\n").length;

    files.push({ path, content: chunk, lineCount, tier });
  }

  return files;
}

function buildFileManifest(
  files: FileDiff[],
  maxEntries: number
): string {
  const tierNames = ["skip", "signal", "source", "tests", "docs/config"];

  if (files.length <= maxEntries) {
    const lines = files.map((f) => {
      const tierLabel = tierNames[f.tier] ?? "unknown";
      return `  ${f.path} (${tierLabel}, ${f.lineCount} lines)`;
    });
    return `File manifest (${files.length} files):\n${lines.join("\n")}`;
  }

  // Aggregate by tier for large diffs
  const byTier: Record<number, number> = {};
  for (const f of files) {
    byTier[f.tier] = (byTier[f.tier] ?? 0) + 1;
  }

  const lines: string[] = [];
  for (const [tier, count] of Object.entries(byTier).sort()) {
    const t = Number(tier);
    if (t === 0) continue;
    lines.push(`  Tier ${t} (${tierNames[t] ?? "unknown"}): ${count} files`);
  }
  return `File manifest (${files.length} files, aggregated by tier):\n${lines.join("\n")}`;
}

export function truncateDiff(rawDiff: string, tokenBudget: number, maxManifestEntries: number): TruncatedDiff {
  const allFiles = parseFileDiffs(rawDiff);
  const totalFiles = allFiles.length;

  // Separate skipped files from those to include
  const skipped = allFiles.filter((f) => f.tier === 0);
  const candidates = allFiles.filter((f) => f.tier !== 0);

  // Sort each tier by line count descending (largest change first)
  const byTier: FileDiff[][] = [[], [], [], [], []];
  for (const f of candidates) {
    (byTier[f.tier] as FileDiff[]).push(f);
  }
  for (const tier of byTier) {
    tier.sort((a, b) => b.lineCount - a.lineCount);
  }

  // Build manifest overhead first (always included)
  const manifest = buildFileManifest(allFiles.filter((f) => f.tier !== 0).concat(skipped), maxManifestEntries);
  const manifestTokens = estimateTokens(manifest);
  let remainingBudget = tokenBudget - manifestTokens;

  const includedFiles: FileDiff[] = [];

  for (let t = 1; t <= 4; t++) {
    const tierFiles = byTier[t] ?? [];
    for (const file of tierFiles) {
      const tokens = estimateTokens(file.content);
      if (tokens <= remainingBudget) {
        includedFiles.push(file);
        remainingBudget -= tokens;
      }
      // If budget gone, skip remaining files in this tier
    }
    if (remainingBudget <= 0) break;
  }

  const diffContent = includedFiles.map((f) => f.content).join("\n");
  const truncated = includedFiles.length < candidates.length;

  const contentParts: string[] = [];
  if (diffContent) contentParts.push(diffContent);
  if (truncated) {
    contentParts.push(
      `(Diff truncated: showing ${includedFiles.length}/${candidates.length} files within token budget)`
    );
  }
  contentParts.push(manifest);

  return {
    content: contentParts.join("\n\n"),
    fileManifest: manifest,
    includedFiles: includedFiles.length,
    totalFiles: totalFiles - skipped.length,
    truncated,
  };
}
