import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseCliArgs, resolveCommand } from "./args";
import { runCli } from "./index";

describe("CLI dispatcher", () => {
  afterEach(() => {
    spyOn(console, "log").mockRestore();
    spyOn(console, "error").mockRestore();
  });

  it("prints help when --help is passed as a flag", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["--help"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("Counterpart Monitor CLI");
  });

  it("prints help when --help follows a command path", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});

    const code = await runCli(["report", "send", "--help"]);

    expect(code).toBe(0);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).toContain("Counterpart Monitor CLI");
  });

  it("keeps command flags available after resolving a command path", () => {
    const parsed = parseCliArgs(["run", "monthly", "--month", "2026-06", "--no-dispatch"]);
    const resolved = resolveCommand(parsed.tokens, [{ path: ["run"], description: "run" }]);

    expect(resolved?.rest).toEqual(["monthly"]);
    expect(parsed.flags).toEqual({ month: "2026-06", "no-dispatch": true });
  });
});
