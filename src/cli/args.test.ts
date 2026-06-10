import { describe, expect, it } from "bun:test";
import { parseCliArgs, resolveCommand } from "./args";

describe("CLI argument parser", () => {
  it("parses global flags before and after command tokens", () => {
    const parsed = parseCliArgs([
      "--json",
      "db",
      "status",
      "--date",
      "2026-06-09",
      "--timezone",
      "Asia/Shanghai",
      "--db",
      "data/copy.db",
      "-v",
    ]);

    expect(parsed.global).toEqual({
      json: true,
      verbose: true,
      timezone: "Asia/Shanghai",
      dbPath: "data/copy.db",
    });
    expect(parsed.tokens).toEqual(["db", "status"]);
    expect(parsed.flags).toEqual({ date: "2026-06-09" });
  });

  it("resolves nested commands by longest prefix", () => {
    const command = resolveCommand(["report", "mark-delivery", "daily"], [
      { path: ["report"], description: "report root" },
      { path: ["report", "mark-delivery"], description: "mark delivery" },
      { path: ["db", "status"], description: "db status" },
    ]);

    expect(command?.command.path).toEqual(["report", "mark-delivery"]);
    expect(command?.rest).toEqual(["daily"]);
  });

  it("keeps report send preview mode as the default without --yes", () => {
    const parsed = parseCliArgs(["report", "send", "monthly", "--month", "2026-06"]);

    expect(parsed.tokens).toEqual(["report", "send", "monthly"]);
    expect(parsed.flags).toEqual({ month: "2026-06" });
    expect(parsed.flags.yes).toBeUndefined();
  });
});
