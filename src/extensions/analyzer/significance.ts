export interface PRData {
  title: string;
  files_changed: number | null;
  additions: number | null;
  deletions: number | null;
}

export function preFilterSignificance(pr: PRData): "likely_routine" | "likely_notable" | "unknown" {
  const filesChanged = pr.files_changed ?? 0;
  const additions = pr.additions ?? 0;

  if (
    filesChanged < 3 &&
    additions < 50 &&
    /fix typo|bump|update deps|docs/i.test(pr.title)
  ) {
    return "likely_routine";
  }

  if (filesChanged > 10 || additions > 500) {
    return "likely_notable";
  }

  return "unknown";
}
