import { describe, it, expect, beforeAll, afterAll, mock } from "bun:test";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import type { CheckerInput } from "./checker";

const TMP_DIR = join(import.meta.dir, "__test-tmp-checker__");
const CLONE_DIR = join(TMP_DIR, "clone");

// Injected settings object — avoids module-level settings state contamination
// from mock.module("../../config/settings") in analyze.test.ts which persists
// for the lifetime of the Bun process.
const FAKE_SETTINGS = {
  llm: {
    model: "claude-sonnet-4-6",
    baseUrl: "http://localhost:4999",
    apiKey: "test-key",
    maxTokensPerCall: 4096,
    diffTokenBudget: 10000,
    maxManifestEntries: 50,
  },
  impactCheck: {
    enabled: true,
    maxChecksPerDay: 5,
    maxStepsPerCheck: 3,
    maxCostPerCheck: 1.0,
    monthlySubCap: 50,
    maxAgeDays: 30,
    clonesDir: "data/mantle-repos",
    maxCloneDiskGB: 10,
    codegraphEnabled: false,
  },
};

const LOW_COST_SETTINGS = {
  ...FAKE_SETTINGS,
  impactCheck: { ...FAKE_SETTINGS.impactCheck, maxCostPerCheck: 0.000001 },
};

function makeInput(overrides: Partial<CheckerInput> = {}): CheckerInput {
  return {
    checkId: "test-check-001",
    target: {
      projectId: "test-org/test-fork",
      tags: [],
      repoUrl: "https://github.com/test-org/test-fork",
      architectureNotes: "A fork of upstream for Mantle usage.",
    },
    relationship: {
      source: "upstream/lib",
      targets: ["test-org/test-fork"],
      relationship: "fork_of",
      reason: "Direct fork",
    },
    cloneState: {
      cloneDir: CLONE_DIR,
      commitHash: "abc123def456",
      lastFetchAt: "2026-06-13T00:00:00Z",
    },
    upstreamPR: {
      title: "Fix buffer overflow in parser",
      body: "This fixes a critical buffer overflow in the parser module.",
      diffRaw: "diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -10,5 +10,5 @@\n-vulnerable_function()\n+safe_function()",
      diffStatus: "available",
    },
    analyzerSummary: {
      summary: "Critical security fix in parser module.",
      technicalDetail: "Fixes buffer overflow via bounds checking.",
    },
    ...overrides,
  };
}

function makeFakeGenerateText(steps = 1) {
  return mock(async (_opts: any) => {
    const stepResults: any[] = [];
    for (let i = 0; i < steps; i++) {
      stepResults.push({ stepNumber: i, toolCalls: [], toolResults: [], usage: { inputTokens: 100, outputTokens: 50 } });
    }
    if (_opts.onStepFinish) {
      for (const step of stepResults) {
        await _opts.onStepFinish(step);
      }
    }
    return {
      text: "Investigation complete.",
      steps: stepResults,
      usage: { inputTokens: steps * 100, outputTokens: steps * 50 },
    };
  });
}

function makeFakeGenerateObject(verdict: object) {
  return mock(async (_opts: any) => ({
    object: verdict,
    usage: { inputTokens: 200, outputTokens: 100 },
  }));
}

const GOOD_VERDICT = {
  affected: "yes",
  impactType: "bug_also_present",
  evidenceKind: "code_evidence",
  evidence: [
    {
      file: "src/parser.ts",
      lines: "10-15",
      snippet: "vulnerable_function_content",
      note: "Same vulnerable code present in fork",
    },
  ],
  confidence: "high",
  summary: "Fork contains the same buffer overflow.",
  recommendedAction: "Apply upstream patch.",
};

beforeAll(() => {
  mkdirSync(CLONE_DIR, { recursive: true });
  mkdirSync(join(CLONE_DIR, "src"), { recursive: true });
  writeFileSync(
    join(CLONE_DIR, "src/parser.ts"),
    "// parser.ts\nfunction parse() {\n  vulnerable_function_content\n  return null;\n}\n"
  );
});

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── Confidence cap: non-code_evidence → max medium ────────────────────────

describe("runImpactCheck — confidence cap enforcement", () => {
  it("demotes high confidence to medium when evidenceKind is reasoning_based", async () => {
    const { runImpactCheck } = await import("./checker");
    const reasoningVerdict = {
      ...GOOD_VERDICT,
      evidenceKind: "reasoning_based",
      evidence: [],
      confidence: "high",
    };

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(reasoningVerdict) as any,
    });

    expect(verdict.confidence).toBe("medium");
  });

  it("demotes high confidence to medium when evidenceKind is manifest_evidence", async () => {
    const { runImpactCheck } = await import("./checker");
    const manifestVerdict = {
      ...GOOD_VERDICT,
      evidenceKind: "manifest_evidence",
      evidence: [],
      confidence: "high",
    };

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(manifestVerdict) as any,
    });

    expect(verdict.confidence).toBe("medium");
  });

  it("allows high confidence when evidenceKind is code_evidence with valid evidence", async () => {
    const { runImpactCheck } = await import("./checker");

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(GOOD_VERDICT) as any,
    });

    expect(verdict.confidence).toBe("high");
    expect(verdict.evidenceVerificationFailed).toBe(false);
  });
});

// ─── Evidence verification failure ────────────────────────────────────────────

describe("runImpactCheck — evidence verification", () => {
  it("sets confidence to low when evidence file does not exist in clone", async () => {
    const { runImpactCheck } = await import("./checker");
    const phantomVerdict = {
      ...GOOD_VERDICT,
      evidence: [
        {
          file: "src/phantom_does_not_exist.ts",
          lines: "1-5",
          snippet: "some code here",
          note: "phantom file",
        },
      ],
    };

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(phantomVerdict) as any,
    });

    expect(verdict.confidence).toBe("low");
    expect(verdict.evidenceVerificationFailed).toBe(true);
  });

  it("sets confidence to low when snippet not found in file", async () => {
    const { runImpactCheck } = await import("./checker");
    const badSnippetVerdict = {
      ...GOOD_VERDICT,
      evidence: [
        {
          file: "src/parser.ts",
          lines: "1-5",
          snippet: "this snippet definitely does not appear in the file anywhere ever",
          note: "bad snippet",
        },
      ],
    };

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(badSnippetVerdict) as any,
    });

    expect(verdict.confidence).toBe("low");
    expect(verdict.evidenceVerificationFailed).toBe(true);
  });

  it("sets confidence to low when evidence file path escapes clone dir", async () => {
    const { runImpactCheck } = await import("./checker");
    const escapingPathVerdict = {
      ...GOOD_VERDICT,
      evidence: [
        {
          file: "../../etc/passwd",
          lines: "1",
          snippet: "root",
          note: "path traversal evidence",
        },
      ],
    };

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(escapingPathVerdict) as any,
    });

    expect(verdict.confidence).toBe("low");
    expect(verdict.evidenceVerificationFailed).toBe(true);
  });
});

// ─── Diff unavailable → cap confidence at medium ──────────────────────────────

describe("runImpactCheck — diff unavailable confidence cap", () => {
  it("caps confidence at medium when diffStatus is unavailable", async () => {
    const { runImpactCheck } = await import("./checker");
    const input = makeInput({
      upstreamPR: {
        title: "Some change",
        body: null,
        diffRaw: null,
        diffStatus: "unavailable",
      },
    });

    const highConfidenceCodeVerdict = { ...GOOD_VERDICT, confidence: "high" };

    const verdict = await runImpactCheck(input, {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(highConfidenceCodeVerdict) as any,
    });

    expect(verdict.confidence).not.toBe("high");
  });
});

// ─── maxCostPerCheck triggers uncertain verdict ──────────────────────────────

describe("runImpactCheck — maxCostPerCheck enforcement", () => {
  it("produces uncertain verdict and terminates loop early when cost limit is exceeded", async () => {
    const { runImpactCheck } = await import("./checker");

    const uncertainVerdict = {
      affected: "uncertain",
      impactType: "not_affected",
      evidenceKind: "reasoning_based",
      evidence: [],
      confidence: "low",
      summary: "Cost limit reached.",
      recommendedAction: "Manual review.",
    };

    // Use a multi-step mock to verify the loop actually exits after the first
    // step instead of running all MAX_POSSIBLE_STEPS.
    let stepsCompletedAfterOnStepFinish = 0;
    const MAX_POSSIBLE_STEPS = 5;
    const multiStepGenerateText = mock(async (_opts: any) => {
      for (let i = 0; i < MAX_POSSIBLE_STEPS; i++) {
        const step = {
          stepNumber: i,
          toolCalls: [],
          toolResults: [],
          usage: { inputTokens: 100, outputTokens: 50 },
        };
        if (_opts.onStepFinish) {
          // With LOW_COST_SETTINGS (cap = 0.000001), first step cost
          // (0.00105) already exceeds cap — sentinel throw aborts here.
          await _opts.onStepFinish(step);
        }
        stepsCompletedAfterOnStepFinish++;
      }
      return {
        text: "",
        steps: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });

    const verdict = await runImpactCheck(makeInput(), {
      settings: LOW_COST_SETTINGS as any,
      generateTextFn: multiStepGenerateText as any,
      generateObjectFn: makeFakeGenerateObject(uncertainVerdict) as any,
    });

    // Loop threw after step 0's onStepFinish — counter was never incremented
    expect(stepsCompletedAfterOnStepFinish).toBe(0);
    expect(verdict.truncatedByCost).toBe(true);
    expect(verdict.affected).toBe("uncertain");
  });
});

// ─── stepCountIs produces verdict (may be uncertain) ─────────────────────────

describe("runImpactCheck — step count limit", () => {
  it("marks truncatedByStepCount when maxSteps is reached", async () => {
    const { runImpactCheck } = await import("./checker");

    // Simulate 3 steps = maxStepsPerCheck in FAKE_SETTINGS
    const stepLimitedGenerateText = mock(async (_opts: any) => {
      const steps = Array.from({ length: 3 }, (_, i) => ({
        stepNumber: i,
        toolCalls: [],
        toolResults: [],
        usage: { inputTokens: 100, outputTokens: 50 },
      }));
      if (_opts.onStepFinish) {
        for (const s of steps) await _opts.onStepFinish(s);
      }
      return {
        text: "Investigation cut short.",
        steps,
        usage: { inputTokens: 300, outputTokens: 150 },
      };
    });

    const uncertainVerdict = {
      affected: "uncertain",
      impactType: "not_affected",
      evidenceKind: "reasoning_based",
      evidence: [],
      confidence: "low",
      summary: "Step limit reached.",
      recommendedAction: "Manual review.",
    };

    const verdict = await runImpactCheck(makeInput(), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: stepLimitedGenerateText as any,
      generateObjectFn: makeFakeGenerateObject(uncertainVerdict) as any,
    });

    expect(verdict.truncatedByStepCount).toBe(true);
    expect(verdict.affected).toBe("uncertain");
  });
});

// ─── Audit trace written ──────────────────────────────────────────────────────

describe("runImpactCheck — audit trace", () => {
  it("writes JSONL audit entries for a check", async () => {
    const { runImpactCheck, AUDIT_DIR } = await import("./checker");
    const checkId = "audit-trace-test-" + Date.now();
    const auditPath = join(AUDIT_DIR, `${checkId}.jsonl`);

    await runImpactCheck(makeInput({ checkId }), {
      settings: FAKE_SETTINGS as any,
      generateTextFn: makeFakeGenerateText() as any,
      generateObjectFn: makeFakeGenerateObject(GOOD_VERDICT) as any,
    });

    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    const types = lines.map((l: any) => l.type);
    expect(types).toContain("check_start");
    expect(types).toContain("verdict");
  });
});
