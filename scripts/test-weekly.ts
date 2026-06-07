/**
 * Quick test script for weekly report generation.
 * Usage: bun run scripts/test-weekly.ts
 * Reads from the existing database, generates the weekly report data + Lark card, prints to stdout.
 * Does NOT send to Lark.
 */
import { getDb } from "../src/storage/db";
import { buildWeeklyReport } from "../src/extensions/report-generator/weekly";
import { buildWeeklyCard } from "../src/extensions/report-generator/templates/weekly-card";
import { getSettings } from "../src/config/settings";

const settings = getSettings();
const timezone = settings.schedule.timezone;

getDb();

console.log(`\n=== Weekly Report Test (timezone: ${timezone}) ===\n`);

const data = buildWeeklyReport(timezone);

console.log("--- Activity Summary ---");
console.log(`  Total PRs: ${data.activitySummary.totalPrs}`);
console.log(`  Projects: ${data.activitySummary.projectCount}`);
console.log(`  Directional Shifts: ${data.activitySummary.directionalShiftCount}`);
console.log(`  Notable: ${data.activitySummary.notableCount}`);

console.log("\n--- Direction Changes ---");
if (data.directionChanges.length === 0) {
  console.log("  (none)");
} else {
  for (const dc of data.directionChanges) {
    console.log(`  ${dc.projectId}: ${dc.prCount} PR(s) — ${dc.signals.join("; ") || "(no signal)"}`);
  }
}

console.log("\n--- Project Highlights ---");
for (const proj of data.projectHighlights) {
  console.log(`\n  [${proj.projectId}] ${proj.prCount} PRs (${proj.directionalShiftCount} directional, ${proj.notableCount} notable)`);
  for (const h of proj.highlights) {
    const badge = h.significance === "directional_shift" ? "DIRECTIONAL" : h.significance === "notable" ? "NOTABLE" : "ROUTINE";
    console.log(`    [${badge}] #${h.prNumber}: ${h.title}`);
    console.log(`             ${h.summary.slice(0, 120)}${h.summary.length > 120 ? "..." : ""}`);
  }
}

console.log("\n--- Counterpart Checks ---");
if (data.counterpartChecks.length === 0) {
  console.log("  (none)");
} else {
  for (const check of data.counterpartChecks) {
    console.log(`  ${check.source.projectId}#${check.source.prNumber} → ${check.targetProjectId} [${check.confidence}]`);
    console.log(`    ${check.whyItMatters}`);
  }
}

// Build Lark card
const startDate = new Date(data.periodStartUnix * 1000);
const endDate = new Date(data.periodEndUnix * 1000);
const dateRange = `${startDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone })} – ${endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: timezone })}`;

const card = buildWeeklyCard(dateRange, data);
const cardJson = JSON.stringify(card, null, 2);

console.log(`\n--- Lark Card JSON (${cardJson.length} bytes) ---`);
console.log(cardJson);

// Write card to file for easier inspection
const outPath = "data/reports/test-weekly-card.json";
await Bun.write(outPath, cardJson);
console.log(`\nCard written to ${outPath}`);
