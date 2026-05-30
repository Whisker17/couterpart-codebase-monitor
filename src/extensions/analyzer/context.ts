import type { TruncatedDiff } from "./diff-truncator";

export interface ProjectContextLite {
  description: string | null;
  language: string | null;
  topics: string[];
  tags: string[];
  notes: string | null;
}

export interface AnalysisContext {
  diff: TruncatedDiff | null;
  supplementaryContext: string | null;
  projectContext: ProjectContextLite;
  inputQuality: "diff_aware" | "metadata_only" | "diff_plus_graph";
}

export function buildProjectContext(row: {
  description: string | null;
  language: string | null;
  topics: string | null;
  overview: string | null;
}): ProjectContextLite {
  let topics: string[] = [];
  if (row.topics) {
    try {
      topics = JSON.parse(row.topics) as string[];
    } catch {
      topics = [];
    }
  }

  return {
    description: row.description,
    language: row.language,
    topics,
    tags: [],
    notes: row.overview,
  };
}
