import type { TruncatedDiff } from "./diff-truncator";
import { getDb } from "../../storage/db";

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

  const db = getDb();
  const projectRow = db
    .query<{ tags: string | null; notes: string | null }, [string]>(
      "SELECT tags, notes FROM projects WHERE id = ?"
    )
    .get(row.project_id);

  const tags = projectRow?.tags ? (JSON.parse(projectRow.tags) as string[]) : [];
  const notes = projectRow?.notes ?? row.overview;

  return {
    description: row.description,
    language: row.language,
    topics,
    tags,
    notes,
  };
}
