import { test, expect, describe } from "bun:test";
import { getYesterdayPeriod, getWeekPeriod, getDayPeriod } from "./time-window";

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
