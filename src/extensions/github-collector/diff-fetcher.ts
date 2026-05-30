import { Octokit } from "octokit";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getSettings } from "../../config/settings";

const MAX_DIFF_BYTES = 2_000_000;

export type DiffStatus = "available" | "fetch_failed" | "too_large";

export interface DiffResult {
  status: DiffStatus;
  path: string | null;
}

let _octokit: Octokit | null = null;

function getOctokit(): Octokit {
  if (_octokit) return _octokit;
  const { github } = getSettings();
  _octokit = new Octokit({ auth: github.token });
  return _octokit;
}

export async function fetchAndStoreDiff(
  org: string,
  repo: string,
  prNumber: number
): Promise<DiffResult> {
  let diffText: string;

  try {
    const octokit = getOctokit();
    const response = await octokit.rest.pulls.get({
      owner: org,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    diffText = response.data as unknown as string;
  } catch {
    return { status: "fetch_failed", path: null };
  }

  const byteLength = Buffer.byteLength(diffText, "utf-8");
  if (byteLength > MAX_DIFF_BYTES) {
    return { status: "too_large", path: null };
  }

  const diffDir = join("data", "diffs", `${org}-${repo}`);
  const diffPath = join(diffDir, `${prNumber}.patch`);
  mkdirSync(diffDir, { recursive: true });
  writeFileSync(diffPath, diffText, "utf-8");

  return { status: "available", path: diffPath };
}
