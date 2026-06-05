import { readFileSync } from "fs";
import { join } from "path";

export interface ProjectConfig {
  org: string;
  repo: string;
  url: string;
  tags?: string[];
  notes?: string;
}

export type TrackedProject = ProjectConfig;

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

let _projects: TrackedProject[] | null = null;
let _mantleConfig: MantleConfig | null = null;
let _projectsConfigPath: string | null = null;

export function _resetProjectsCache(): void {
  _projects = null;
}

export function _setProjectsConfigPath(path: string | null): void {
  _projectsConfigPath = path;
}

function getProjectsConfigPath(): string {
  return _projectsConfigPath ?? join(process.cwd(), "config", "projects.json");
}

function validateProjects(data: unknown): TrackedProject[] {
  if (!Array.isArray(data)) {
    throw new Error("projects.json must be an array");
  }
  for (const entry of data) {
    if (!entry || typeof entry.org !== "string" || entry.org.length === 0) {
      throw new Error("Each project must have a non-empty org");
    }
    if (typeof entry.repo !== "string" || entry.repo.length === 0) {
      throw new Error("Each project must have a non-empty repo");
    }
    if (typeof entry.url !== "string" || !entry.url.startsWith("https://github.com/")) {
      throw new Error("Each project url must start with https://github.com/");
    }
  }
  return data as TrackedProject[];
}

export function getTrackedProjects(): TrackedProject[] {
  if (_projects) return _projects;
  const raw = readFileSync(getProjectsConfigPath(), "utf-8");
  const data = JSON.parse(raw);
  _projects = validateProjects(data);
  return _projects;
}

export function getMantleConfig(): MantleConfig {
  if (_mantleConfig) return _mantleConfig;
  const configPath = join(process.cwd(), "config", "mantle-config.json");
  const raw = readFileSync(configPath, "utf-8");
  _mantleConfig = JSON.parse(raw) as MantleConfig;
  return _mantleConfig;
}

export function reloadTrackedProjects(): {
  projects: TrackedProject[];
  prevProjects: TrackedProject[] | null;
  changed: boolean;
} {
  const prev = _projects;

  let next: TrackedProject[];
  try {
    const raw = readFileSync(getProjectsConfigPath(), "utf-8");
    const data = JSON.parse(raw);
    next = validateProjects(data);
  } catch (e) {
    if (prev) {
      console.warn(`[config-reload] Failed to reload projects.json, using cached projects: ${e}`);
      return { projects: prev, prevProjects: prev, changed: false };
    }
    throw new Error(`[config-reload] projects.json invalid and no cached projects available: ${e}`);
  }

  const changed = JSON.stringify(prev) !== JSON.stringify(next);
  _projects = next;
  return { projects: next, prevProjects: prev, changed };
}
