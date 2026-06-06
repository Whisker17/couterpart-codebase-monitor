import { mkdirSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { LarkCard } from "./templates/daily-card";
import type { GroupedAnalyses } from "./templates/daily-card";

const REPORTS_DIR = "data/reports";

export interface ReportCompleteness {
  total: number;
  success: number;
  failed: string[];
  status?: string;
  prTotal?: number;
  prComplete?: number;
  prIncomplete?: number;
  collectionIncomplete?: boolean;
}

export interface ReportFileContent {
  date: string;
  card: LarkCard | LarkCard[];
  analyses: GroupedAnalyses;
  completeness: ReportCompleteness;
}

export function writeReportFile(content: ReportFileContent): string {
  const path = `${REPORTS_DIR}/${content.date}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(content, null, 2), "utf-8");
  return path;
}
