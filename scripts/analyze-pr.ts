// Ad-hoc: run the impact-check pipeline on a SINGLE upstream PR (not DB-queue driven).
// Fetches the PR title/body/diff from GitHub, maps it to Mantle target(s) via
// mantle-config counterpartRelationships (or an explicit override), runs the real
// runImpactCheck against the cached clone, and prints the verdict + alert decision.
//
//   bun run scripts/analyze-pr.ts <pr-url> [--target <projectId>] [--relationship fork_of|depends_on|protocol_dependency] [--ref <commit|branch|tag>]
//   e.g. bun run scripts/analyze-pr.ts https://github.com/ethereum-optimism/optimism/pull/12345
//   --ref pins the downstream clone to a specific commit/branch/tag for THIS run only
//   (e.g. the parent of a known adaptation commit, to reproduce a human's judgment).
import { execFileSync } from "node:child_process";
import { Octokit } from "octokit";
import { getSettings } from "../src/config/settings";
import { getMantleConfig } from "../src/config/projects";
import { syncTarget } from "../src/extensions/impact-checker/clone-manager";
import { runImpactCheck } from "../src/extensions/impact-checker/checker";
import type { CheckerInput } from "../src/extensions/impact-checker/checker";
import { renderAlertCardZh } from "../src/extensions/impact-checker/alert-card";

const MAX_DIFF_BYTES = 2_000_000;

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let target: string | undefined;
  let relationship: string | undefined;
  let ref: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") target = argv[++i];
    else if (argv[i] === "--relationship") relationship = argv[++i];
    else if (argv[i] === "--ref") ref = argv[++i];
    else positional.push(argv[i]!);
  }
  return { url: positional[0], target, relationship, ref };
}

// Pin the (already-cloned) shallow target to a specific commit/branch/tag for this run only.
// The next real impact-check run re-fetches the configured branch tip, so this is non-destructive.
function pinCloneToRef(cloneDir: string, ref: string): string {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: cloneDir, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
  // GitHub allows fetching a reachable SHA (or branch/tag) directly; --depth 1 keeps it shallow.
  git(["fetch", "--depth", "1", "origin", ref]);
  git(["reset", "--hard", "FETCH_HEAD"]);
  return git(["rev-parse", "HEAD"]).trim();
}

function parsePrUrl(url: string): { owner: string; repo: string; prNumber: number } {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) throw new Error(`Not a GitHub PR URL: ${url}`);
  return { owner: m[1]!, repo: m[2]!, prNumber: parseInt(m[3]!, 10) };
}

const { url, target: targetOverride, relationship: relOverride, ref: refOverride } = parseArgs(process.argv.slice(2));
if (!url) {
  console.error("usage: bun run scripts/analyze-pr.ts <pr-url> [--target <id>] [--relationship <type>] [--ref <commit|branch|tag>]");
  process.exit(1);
}

const { owner, repo, prNumber } = parsePrUrl(url);
const sourceId = `${owner}/${repo}`;
const settings = getSettings();
const mc = getMantleConfig();
const token = settings.github.token ?? process.env.GITHUB_TOKEN;
const octokit = new Octokit({ auth: token });

// 1. Resolve which target(s)/relationship(s) this PR maps to
type Edge = { targetId: string; relationship: "fork_of" | "depends_on" | "protocol_dependency" };
let edges: Edge[] = [];
if (targetOverride) {
  edges = [{ targetId: targetOverride, relationship: (relOverride as Edge["relationship"]) ?? "depends_on" }];
} else {
  for (const rel of mc.counterpartRelationships) {
    if (rel.source !== sourceId) continue;
    if (rel.relationship === "manual") continue;
    for (const t of rel.targets) edges.push({ targetId: t, relationship: rel.relationship as Edge["relationship"] });
  }
}
if (edges.length === 0) {
  console.error(
    `No counterpartRelationship maps ${sourceId} to a Mantle target. ` +
      `Pass --target <projectId> [--relationship depends_on] to force one.`
  );
  process.exit(1);
}

// 2. Fetch PR metadata + diff
console.log(`\n=== Source PR: ${sourceId}#${prNumber} ===`);
const prRes = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
const title = prRes.data.title;
const body = prRes.data.body ?? null;
console.log(`Title: ${title}`);
console.log(`Merged: ${prRes.data.merged_at ?? "(not merged)"}  files: ${prRes.data.changed_files}  +${prRes.data.additions}/-${prRes.data.deletions}`);

let diffRaw: string | null = null;
let diffStatus: "available" | "unavailable" | "too_large" = "unavailable";
try {
  const diffRes = await octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });
  const raw = diffRes.data as unknown as string;
  if (Buffer.byteLength(raw, "utf-8") > MAX_DIFF_BYTES) {
    diffStatus = "too_large";
    console.log(`Diff: too_large (> ${MAX_DIFF_BYTES} bytes) — running with diff omitted`);
  } else {
    diffRaw = raw;
    diffStatus = "available";
    console.log(`Diff: ${Buffer.byteLength(raw, "utf-8")} bytes`);
  }
} catch (e) {
  console.log(`Diff fetch failed: ${e instanceof Error ? e.message : String(e)} — running with diff unavailable`);
}

// Full upstream file content at the PR head — lets the contract-drift pre-pass harvest the complete
// sibling set of a changed struct (the diff's narrow context is too thin to find a lagging mirror).
const headSha = prRes.data.head.sha;
const getFile = async (path: string): Promise<string | null> => {
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path, ref: headSha });
    const data = res.data as { content?: string; encoding?: string };
    if (data.content && data.encoding === "base64") return Buffer.from(data.content, "base64").toString("utf-8");
    return null;
  } catch {
    return null;
  }
};

const cloneOpts = {
  clonesDir: settings.impactCheck!.clonesDir,
  maxCloneDiskGB: settings.impactCheck!.maxCloneDiskGB,
};

// 3. Run a check per mapped target
for (const edge of edges) {
  const targetCfg = mc.mantleTargets.find((t) => t.projectId === edge.targetId);
  if (!targetCfg) {
    console.log(`\n--- ${edge.targetId}: SKIP (not a configured mantleTarget) ---`);
    continue;
  }
  const rel =
    mc.counterpartRelationships.find(
      (r) => r.source === sourceId && r.relationship === edge.relationship && r.targets.includes(edge.targetId)
    ) ?? {
      source: sourceId,
      targets: [edge.targetId],
      relationship: edge.relationship,
      reason: `(override) ${sourceId} ${edge.relationship} ${edge.targetId}`,
    };

  console.log(`\n--- Checking against ${edge.targetId} [${edge.relationship}] ---`);
  const clone = await syncTarget(targetCfg, cloneOpts);
  if (!clone.available) {
    console.log(`  clone unavailable — skipping`);
    continue;
  }

  // Pin to an explicit ref for this run (e.g. the parent of a known adaptation commit).
  let commitHash = clone.commitHash;
  if (refOverride) {
    try {
      commitHash = pinCloneToRef(clone.cloneDir, refOverride);
      console.log(`  pinned to --ref ${refOverride} -> ${commitHash.slice(0, 12)}`);
    } catch (e) {
      console.log(`  ✗ could not pin to ref "${refOverride}": ${e instanceof Error ? e.message : String(e)} — skipping`);
      continue;
    }
  } else {
    console.log(`  clone @ ${commitHash.slice(0, 12)} (${clone.lastFetchAt}, branch tip)`);
  }

  const input: CheckerInput = {
    checkId: `adhoc-${sourceId.replace("/", "_")}-${prNumber}-${edge.targetId.replace("/", "_")}`,
    target: targetCfg,
    relationship: rel,
    cloneState: { cloneDir: clone.cloneDir, commitHash, lastFetchAt: clone.lastFetchAt },
    upstreamPR: { title, body, diffRaw, diffStatus, getFile },
    analyzerSummary: null,
  };

  const v = await runImpactCheck(input);
  const card = await renderAlertCardZh(
    {
      checkId: 0,
      verdict: v,
      prNumber,
      prTitle: title,
      sourceProjectId: sourceId,
      targetProjectId: edge.targetId,
      targetCommit: commitHash,
    },
    settings
  );

  console.log(`  VERDICT: affected=${v.affected}  severity=${v.severity}  confidence=${v.confidence}  impactType=${v.impactType}`);
  console.log(`  evidenceKind=${v.evidenceKind}  steps=${v.toolSteps}  cost=$${v.cost.toFixed(3)}`);
  console.log(`  WOULD ALERT (push 🚨): ${card !== null ? "YES" : "no"}`);
  console.log(`  summary: ${v.summary}`);
  console.log(`  recommendedAction: ${v.recommendedAction}`);
  if (v.evidence.length) {
    console.log(`  evidence:`);
    for (const e of v.evidence) console.log(`    - ${e.file}:${e.lines} — ${e.note}`);
  }
}
