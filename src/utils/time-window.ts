function getLocalDateParts(
  timezone: string,
  date: Date
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const get = (type: string): number =>
    parseInt(parts.find((p) => p.type === type)!.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

function localMidnightToUTC(
  timezone: string,
  year: number,
  month: number,
  day: number
): number {
  const probe = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  }).formatToParts(probe);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    return part ? parseInt(part.value) : 0;
  };
  const localMs = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour") % 24,
    get("minute"),
    get("second")
  );
  const offset = localMs - probe.getTime();
  return probe.getTime() - offset;
}

export function getYesterdayPeriod(
  timezone: string,
  now: Date = new Date()
): { startUnix: number; endUnix: number } {
  const { year, month, day } = getLocalDateParts(timezone, now);
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
  const yYear = yesterday.getUTCFullYear();
  const yMonth = yesterday.getUTCMonth() + 1;
  const yDay = yesterday.getUTCDate();
  const startMs = localMidnightToUTC(timezone, yYear, yMonth, yDay);
  const endMs = localMidnightToUTC(timezone, year, month, day) - 1000;
  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000),
  };
}

export function getWeekPeriod(
  timezone: string,
  now: Date = new Date()
): { startUnix: number; endUnix: number } {
  const { year, month, day } = getLocalDateParts(timezone, now);
  const yesterday = new Date(Date.UTC(year, month - 1, day - 1));
  const yYear = yesterday.getUTCFullYear();
  const yMonth = yesterday.getUTCMonth() + 1;
  const yDay = yesterday.getUTCDate();
  const weekStart = new Date(Date.UTC(yYear, yMonth - 1, yDay - 6));
  const wsYear = weekStart.getUTCFullYear();
  const wsMonth = weekStart.getUTCMonth() + 1;
  const wsDay = weekStart.getUTCDate();
  const startMs = localMidnightToUTC(timezone, wsYear, wsMonth, wsDay);
  const endMs = localMidnightToUTC(timezone, year, month, day) - 1000;
  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000),
  };
}

export function getDayPeriod(
  timezone: string,
  dayString: string
): { startUnix: number; endUnix: number } {
  const match = dayString.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid dayString format: "${dayString}". Expected YYYY-MM-DD.`);
  }
  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  const day = parseInt(match[3]!, 10);
  const startMs = localMidnightToUTC(timezone, year, month, day);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const endMs = localMidnightToUTC(
    timezone,
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate()
  ) - 1000;
  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000),
  };
}

export function getMonthPeriod(
  timezone: string,
  monthString: string,
  now: Date = new Date()
): {
  startUnix: number;
  endUnix: number;
  startDate: string;
  endDate: string;
  month: string;
  isPartial: boolean;
} {
  const match = monthString.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid monthString format: "${monthString}". Expected YYYY-MM.`);
  }

  const year = parseInt(match[1]!, 10);
  const month = parseInt(match[2]!, 10);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid monthString month: "${monthString}". Expected 01-12.`);
  }

  const { year: nowYear, month: nowMonth, day: nowDay } = getLocalDateParts(timezone, now);
  const requestedMonthStart = Date.UTC(year, month - 1, 1);
  const currentMonthStart = Date.UTC(nowYear, nowMonth - 1, 1);
  const nextMonth = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  let endYear = nextMonth.getUTCFullYear();
  let endMonth = nextMonth.getUTCMonth() + 1;
  let endDay = nextMonth.getUTCDate();
  let endDateDay = lastDay;
  let isPartial = false;

  if (requestedMonthStart === currentMonthStart) {
    isPartial = true;
    if (nowDay <= 1) {
      throw new Error(`Current month "${monthString}" has no completed local days yet.`);
    }
    endYear = nowYear;
    endMonth = nowMonth;
    endDay = nowDay;
    endDateDay = Math.max(0, nowDay - 1);
  } else if (requestedMonthStart > currentMonthStart) {
    throw new Error(`Cannot build a monthly period for future month: "${monthString}".`);
  }

  const startMs = localMidnightToUTC(timezone, year, month, 1);
  const endMs = localMidnightToUTC(timezone, endYear, endMonth, endDay) - 1000;

  return {
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000),
    startDate: `${monthString}-01`,
    endDate: `${monthString}-${String(endDateDay).padStart(2, "0")}`,
    month: monthString,
    isPartial,
  };
}

export function getPreviousMonthString(timezone: string, now: Date = new Date()): string {
  const { year: localYear, month: localMonth } = getLocalDateParts(timezone, now);
  let year = localYear;
  let month = localMonth - 1;
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}
