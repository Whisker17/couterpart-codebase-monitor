import { describe, expect, it, mock } from "bun:test";
import { localizeDailyDelivery, localizeWeeklyDelivery } from "./delivery-localizer";
import type { GroupedAnalyses } from "./templates/daily-card";
import type { WeeklyReportData } from "./weekly";

const dailyData: GroupedAnalyses = [
  {
    projectId: "org/repo",
    prCount: 1,
    directionalShiftCount: 1,
    notableCount: 0,
    topDirectionSignal: "Moving from gRPC to JSON-RPC for Ethereum tooling alignment.",
    prs: [
      {
        prNumber: 1,
        title: "Migrate prover service to JSON-RPC",
        htmlUrl: "https://github.com/org/repo/pull/1",
        summary: "Migrates the prover service API from gRPC to JSON-RPC and removes protobuf generation.",
        technicalDetail: "Detailed implementation text should stay out of delivery localization.",
        significance: "directional_shift",
        directionSignal: "This suggests stronger alignment with Ethereum JSON-RPC conventions.",
      },
    ],
  },
];

const weeklyData: WeeklyReportData = {
  directionChanges: [
    {
      projectId: "org/repo",
      prCount: 1,
      signals: ["Moving from gRPC to JSON-RPC for Ethereum tooling alignment."],
    },
  ],
  activitySummary: {
    totalPrs: 1,
    directionalShiftCount: 1,
    notableCount: 0,
    projectCount: 1,
  },
  projectHighlights: [
    {
      projectId: "org/repo",
      prCount: 1,
      directionalShiftCount: 1,
      notableCount: 0,
      highlights: [
        {
          prNumber: 1,
          title: "Migrate prover service to JSON-RPC",
          htmlUrl: "https://github.com/org/repo/pull/1",
          summary: "Migrates the prover service API from gRPC to JSON-RPC and removes protobuf generation.",
          significance: "directional_shift",
          directionSignal: "This suggests stronger alignment with Ethereum JSON-RPC conventions.",
        },
      ],
    },
  ],
  counterpartChecks: [],
  periodStartUnix: 1,
  periodEndUnix: 2,
};

describe("delivery localizer", () => {
  it("localizes daily summaries and direction signals without mutating source data", async () => {
    const generateFn = mock(async () => ({
      object: {
        entries: [
          {
            key: "daily:top:org/repo",
            text: "从 gRPC 转向 JSON-RPC，以贴近 Ethereum 工具体系。",
          },
          {
            key: "daily:pr:org/repo:1:summary",
            text: "将 prover service API 从 gRPC 迁移到 JSON-RPC，去掉 protobuf 生成链路。",
          },
          {
            key: "daily:pr:org/repo:1:direction",
            text: "方向上更贴近 Ethereum 的 JSON-RPC 约定。",
          },
        ],
      },
      usage: {},
    }));

    const localized = await localizeDailyDelivery(dailyData, { generateFn, skipCredentialCheck: true });

    expect(localized[0]!.topDirectionSignal).toBe("从 gRPC 转向 JSON-RPC，以贴近 Ethereum 工具体系。");
    expect(localized[0]!.prs[0]!.summary).toBe("将 prover service API 从 gRPC 迁移到 JSON-RPC，去掉 protobuf 生成链路。");
    expect(localized[0]!.prs[0]!.directionSignal).toBe("方向上更贴近 Ethereum 的 JSON-RPC 约定。");
    expect(localized[0]!.prs[0]!.title).toBe("Migrate prover service to JSON-RPC");
    expect(localized[0]!.prs[0]!.htmlUrl).toBe("https://github.com/org/repo/pull/1");
    expect(dailyData[0]!.prs[0]!.summary).toContain("Migrates the prover service API");
  });

  it("localizes weekly direction changes and highlights", async () => {
    const generateFn = mock(async () => ({
      object: {
        entries: [
          {
            key: "weekly:direction:org/repo:0",
            text: "从 gRPC 转向 JSON-RPC，以贴近 Ethereum 工具体系。",
          },
          {
            key: "weekly:highlight:org/repo:1:summary",
            text: "将 prover service API 从 gRPC 迁移到 JSON-RPC。",
          },
          {
            key: "weekly:highlight:org/repo:1:direction",
            text: "方向上更贴近 Ethereum 的 JSON-RPC 约定。",
          },
        ],
      },
      usage: {},
    }));

    const localized = await localizeWeeklyDelivery(weeklyData, { generateFn, skipCredentialCheck: true });

    expect(localized.directionChanges[0]!.signals[0]).toBe("从 gRPC 转向 JSON-RPC，以贴近 Ethereum 工具体系。");
    expect(localized.projectHighlights[0]!.highlights[0]!.summary).toBe("将 prover service API 从 gRPC 迁移到 JSON-RPC。");
    expect(localized.projectHighlights[0]!.highlights[0]!.directionSignal).toBe("方向上更贴近 Ethereum 的 JSON-RPC 约定。");
    expect(localized.projectHighlights[0]!.highlights[0]!.title).toBe("Migrate prover service to JSON-RPC");
    expect(localized.projectHighlights[0]!.highlights[0]!.htmlUrl).toBe("https://github.com/org/repo/pull/1");
  });

  it("falls back to original data when localization fails", async () => {
    const generateFn = mock(async () => {
      throw new Error("LLM unavailable");
    });

    const localized = await localizeDailyDelivery(dailyData, { generateFn, skipCredentialCheck: true });

    expect(localized).toEqual(dailyData);
    expect(localized).not.toBe(dailyData);
  });

  it("localizes all daily entries across batches", async () => {
    const manyPrs: GroupedAnalyses = [
      {
        projectId: "org/repo",
        prCount: 81,
        directionalShiftCount: 0,
        notableCount: 81,
        topDirectionSignal: null,
        prs: Array.from({ length: 81 }, (_, i) => ({
          prNumber: i + 1,
          title: `PR ${i + 1}`,
          htmlUrl: `https://github.com/org/repo/pull/${i + 1}`,
          summary: `English summary ${i + 1}`,
          technicalDetail: null,
          significance: "notable" as const,
          directionSignal: null,
        })),
      },
    ];
    const generateFn = mock(async ({ prompt }: { prompt: string }) => {
      const keys = Array.from(prompt.matchAll(/key: ([^\n]+)/g), (match) => match[1]!);
      return {
        object: {
          entries: keys.map((key) => ({ key, text: `中文 ${key}` })),
        },
        usage: {},
      };
    });

    const localized = await localizeDailyDelivery(manyPrs, { generateFn, skipCredentialCheck: true });

    expect(generateFn).toHaveBeenCalledTimes(4);
    expect(localized[0]!.prs[80]!.summary).toBe("中文 daily:pr:org/repo:81:summary");
  });
});
