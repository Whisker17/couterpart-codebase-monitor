import { describe, expect, it } from "bun:test";
import { resolveBackfillOptions } from "./backfill";

describe("backfill CLI command", () => {
  it("uses global timezone override for date window resolution", () => {
    expect(
      resolveBackfillOptions(
        { since: "2026-06-01", until: "2026-06-02", "allow-partial": true },
        { json: false, verbose: false, timezone: "UTC" },
        "Asia/Shanghai"
      )
    ).toEqual({
      since: "2026-06-01",
      until: "2026-06-02",
      allowPartial: true,
      timezone: "UTC",
    });
  });
});
