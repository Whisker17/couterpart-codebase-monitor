import { readFileSync } from "fs";
import { join } from "path";

export interface ProjectConfig {
  org: string;
  repo: string;
  url: string;
  tags?: string[];
  notes?: string;
}

let _projects: ProjectConfig[] | null = null;

export function getTrackedProjects(): ProjectConfig[] {
  if (_projects) return _projects;
  const configPath = join(process.cwd(), "config", "projects.json");
  const raw = readFileSync(configPath, "utf-8");
  _projects = JSON.parse(raw) as ProjectConfig[];
  return _projects;
}
