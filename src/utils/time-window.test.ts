import { test, expect, describe } from "bun:test";
import { getYesterdayPeriod, getWeekPeriod, getDayPeriod, getMonthPeriod, getPreviousMonthString } from "./time-window";

test("getYesterdayPeriod: Shanghai daily window", () => {
  const now = new Date("2026-06-03T01:00:00Z");
  const result = getYesterdayPeriod("Asia/Shanghai", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 5, 1, 16, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 2, 15, 59, 59) / 1000);
});

test("getWeekPeriod: Shanghai weekly window", () => {
  const now = new Date("2026-06-08T01:30:00Z");
  const result = getWeekPeriod("Asia/Shanghai", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 4, 31, 16, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 7, 15, 59, 59) / 1000);
});

test("getYesterdayPeriod: UTC daily window", () => {
  const now = new Date("2026-06-03T01:00:00Z");
  const result = getYesterdayPeriod("UTC", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 5, 2, 0, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 2, 23, 59, 59) / 1000);
});

test("getWeekPeriod: UTC weekly window", () => {
  const now = new Date("2026-06-08T00:00:00Z");
  const result = getWeekPeriod("UTC", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 5, 1, 0, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 5, 7, 23, 59, 59) / 1000);
});

test("getYesterdayPeriod: New York spring-forward day end is 23 h after start", () => {
  const now = new Date("2026-03-09T16:00:00Z");
  const result = getYesterdayPeriod("America/New_York", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 2, 8, 5, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 2, 9, 3, 59, 59) / 1000);
});

test("getYesterdayPeriod: New York fall-back day end is 25 h after start", () => {
  const now = new Date("2026-11-02T17:00:00Z");
  const result = getYesterdayPeriod("America/New_York", now);
  expect(result.startUnix).toBe(Date.UTC(2026, 10, 1, 4, 0, 0) / 1000);
  expect(result.endUnix).toBe(Date.UTC(2026, 10, 2, 4, 59, 59) / 1000);
});

describe("getDayPeriod", () => {
  test("throws on invalid format", () => {
    expect(() => getDayPeriod("UTC", "2026/06/03")).toThrow();
    expect(() => getDayPeriod("UTC", "20260603")).toThrow();
    expect(() => getDayPeriod("UTC", "not-a-date")).toThrow();
    expect(() => getDayPeriod("UTC", "2026-6-3")).toThrow();
  });

  test("UTC: 2026-06-03 spans full UTC day", () => {
    const result = getDayPeriod("UTC", "2026-06-03");
    expect(result.startUnix).toBe(Date.UTC(2026, 5, 3, 0, 0, 0) / 1000);
    expect(result.endUnix).toBe(Date.UTC(2026, 5, 3, 23, 59, 59) / 1000);
  });

  test("Asia/Shanghai: 2026-06-03 produces correct UTC boundaries (UTC+8)", () => {
    const result = getDayPeriod("Asia/Shanghai", "2026-06-03");
    // Shanghai is UTC+8: local midnight 2026-06-03 00:00 = 2026-06-02 16:00 UTC
    expect(result.startUnix).toBe(Date.UTC(2026, 5, 2, 16, 0, 0) / 1000);
    // local midnight 2026-06-04 00:00 = 2026-06-03 16:00 UTC, minus 1 s
    expect(result.endUnix).toBe(Date.UTC(2026, 5, 3, 15, 59, 59) / 1000);
  });

  test("result matches getYesterdayPeriod for the same calendar day in Shanghai", () => {
    // getYesterdayPeriod with now = 2026-06-03T01:00:00Z gives yesterday = 2026-06-02 in Shanghai
    const yesterday = getYesterdayPeriod("Asia/Shanghai", new Date("2026-06-03T01:00:00Z"));
    const day = getDayPeriod("Asia/Shanghai", "2026-06-02");
    expect(day.startUnix).toBe(yesterday.startUnix);
    expect(day.endUnix).toBe(yesterday.endUnix);
  });
});

describe("getMonthPeriod", () => {
  test("throws on invalid format", () => {
    expect(() => getMonthPeriod("UTC", "2026/06")).toThrow();
    expect(() => getMonthPeriod("UTC", "202606")).toThrow();
    expect(() => getMonthPeriod("UTC", "2026-6")).toThrow();
    expect(() => getMonthPeriod("UTC", "2026-13")).toThrow();
  });

  test("historical UTC month spans the full calendar month", () => {
    const result = getMonthPeriod("UTC", "2026-05", new Date("2026-06-09T00:00:00Z"));
    expect(result.startUnix).toBe(Date.UTC(2026, 4, 1, 0, 0, 0) / 1000);
    expect(result.endUnix).toBe(Date.UTC(2026, 4, 31, 23, 59, 59) / 1000);
    expect(result.startDate).toBe("2026-05-01");
    expect(result.endDate).toBe("2026-05-31");
    expect(result.isPartial).toBe(false);
  });

  test("current Shanghai month ends at yesterday local day", () => {
    const result = getMonthPeriod(
      "Asia/Shanghai",
      "2026-06",
      new Date("2026-06-09T01:00:00Z")
    );
    expect(result.startUnix).toBe(Date.UTC(2026, 4, 31, 16, 0, 0) / 1000);
    expect(result.endUnix).toBe(Date.UTC(2026, 5, 8, 15, 59, 59) / 1000);
    expect(result.startDate).toBe("2026-06-01");
    expect(result.endDate).toBe("2026-06-08");
    expect(result.isPartial).toBe(true);
  });

  test("future month is rejected", () => {
    expect(() => getMonthPeriod("UTC", "2026-07", new Date("2026-06-09T00:00:00Z"))).toThrow();
  });
});

describe("getPreviousMonthString", () => {
  test("returns the previous local month", () => {
    expect(getPreviousMonthString("UTC", new Date("2026-06-10T12:00:00Z"))).toBe("2026-05");
  });

  test("handles January by crossing into the previous year", () => {
    expect(getPreviousMonthString("UTC", new Date("2026-01-10T12:00:00Z"))).toBe("2025-12");
  });
});
