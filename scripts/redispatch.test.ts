import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./redispatch.ts", import.meta.url), "utf-8");

describe("redispatch script safety guards", () => {
  it("does not reset the initial latest report before full E2E resolves the current-period report", () => {
    const dispatchOnlyReturn = source.indexOf("return failed > 0 ? 1 : 0;");
    const fullE2ELog = source.indexOf('console.log("\\n[Redispatch] Running full daily E2E pipeline');
    const preFullE2E = source.slice(dispatchOnlyReturn, fullE2ELog);

    expect(preFullE2E).not.toContain("resetDeliveries(targetReport.id, deliveries);");
  });

  it("does not fall back to dispatching the initial latest report when the current-period report is missing", () => {
    expect(source).not.toContain(
      "const dispatchReportId = currentPeriodReport ? currentPeriodReport.report.id : targetReport.id;"
    );
    expect(source).toContain("if (!currentPeriodReport)");
  });

  it("refreshes generated delivery content before resetting current report for full E2E dispatch", () => {
    const reportLookup = source.indexOf("const currentPeriodReport = findReportByPeriod(startUnix);");
    const refreshCall = source.indexOf("refreshDeliveriesFromReportContent(dispatchReportId);");
    const resetCurrentReport = source.indexOf("resetDeliveries(dispatchReportId, refreshedDeliveries);");

    expect(reportLookup).toBeGreaterThan(-1);
    expect(refreshCall).toBeGreaterThan(reportLookup);
    expect(resetCurrentReport).toBeGreaterThan(refreshCall);
  });

  it("makes dispatch-only mode explicit about re-sending stored card JSON", () => {
    expect(source).toContain("--dispatch-only re-sends stored report_deliveries.content");
    expect(source).toContain("does not regenerate card JSON");
  });
});
