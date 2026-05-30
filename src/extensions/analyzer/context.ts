import type { TruncatedDiff } from "./diff-truncator";
import { getTrackedProjects } from "../../config/projects";

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
  project_id: string;
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

  // Resolve tags + notes from project config (project_id = "org/repo")
  const [org, repo] = row.project_id.split("/");
  const projectConfig = getTrackedProjects().find(
    (p) => p.org === org && p.repo === repo
  );

  return {
    description: row.description,
    language: row.language,
    topics,
    tags: projectConfig?.tags ?? [],
    notes: projectConfig?.notes ?? row.overview,
  };
}
