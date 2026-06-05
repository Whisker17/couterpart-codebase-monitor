import { readFileSync } from "fs";
import { join } from "path";

export interface ProjectConfig {
  org: string;
  repo: string;
  url: string;
  tags?: string[];
  notes?: string;
}

export interface MantleTarget {
  projectId: string;
  tags: string[];
  notes?: string;
}

export interface CounterpartRelationship {
  source: string;
  targets: string[];
  relationship: "manual";
  reason: string;
}

export interface MantleConfig {
  mantleTargets: MantleTarget[];
  counterpartRelationships: CounterpartRelationship[];
}

let _projects: ProjectConfig[] | null = null;
let _mantleConfig: MantleConfig | null = null;

export function getTrackedProjects(): ProjectConfig[] {
  if (_projects) return _projects;
  const configPath = join(process.cwd(), "config", "projects.json");
  const raw = readFileSync(configPath, "utf-8");
  _projects = JSON.parse(raw) as ProjectConfig[];
  return _projects;
}

export function getMantleConfig(): MantleConfig {
  if (_mantleConfig) return _mantleConfig;
  const configPath = join(process.cwd(), "config", "mantle-config.json");
  const raw = readFileSync(configPath, "utf-8");
  _mantleConfig = JSON.parse(raw) as MantleConfig;
  return _mantleConfig;
}
