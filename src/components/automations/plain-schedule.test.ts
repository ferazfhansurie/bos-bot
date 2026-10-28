import { describe, expect, it } from "vitest";
import { plainDays, plainSchedule, plainTime } from "./plain-schedule";

const tz = "Asia/Kuala_Lumpur";

describe("plainTime", () => {
  it("reads like a person would say it", () => {
    expect(plainTime(9, 0)).toBe("9am");
    expect(plainTime(13, 30)).toBe("1:30pm");
    expect(plainTime(0, 0)).toBe("12am");
    expect(plainTime(12, 5)).toBe("12:05pm");
  });
});

describe("plainDays", () => {
  it("names common day sets", () => {
    expect(plainDays([1, 2, 3, 4, 5])).toBe("every weekday");
    expect(plainDays([0, 1, 2, 3, 4, 5, 6])).toBe("every day");
    expect(plainDays([])).toBe("every day");
    expect(plainDays([6, 0])).toBe("every weekend");
    expect(plainDays([1])).toBe("every monday");
    expect(plainDays([5, 1, 3])).toBe("mon/wed/fri");
  });
});

describe("plainSchedule", () => {
  it("says daily schedules plainly", () => {
    expect(plainSchedule({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, tz)).toBe("every weekday at 9am");
    expect(plainSchedule({ type: "daily", time: "10:00", weekdays: [1, 3, 5] }, tz)).toBe("mon/wed/fri at 10am");
    expect(plainSchedule({ type: "daily", time: "07:15", weekdays: [0, 1, 2, 3, 4, 5, 6] }, tz)).toBe("every day at 7:15am");
  });

  it("says intervals with their limits", () => {
    expect(plainSchedule({ type: "interval", everyMinutes: 15, anchorAt: 0 }, tz)).toBe("every 15 minutes");
    expect(plainSchedule({ type: "interval", everyMinutes: 60, anchorAt: 0 }, tz)).toBe("every hour");
    expect(plainSchedule({ type: "interval", everyMinutes: 120, anchorAt: 0 }, tz)).toBe("every 2 hours");
    expect(plainSchedule({
      type: "interval",
      everyMinutes: 30,
      anchorAt: 0,
      weekdays: [1, 2, 3, 4, 5],
      window: { start: "09:00", end: "17:00" },
    }, tz)).toBe("every 30 minutes, 9am–5pm, weekdays");
  });

  it("translates simple cron expressions", () => {
    expect(plainSchedule({ type: "cron", expression: "0 9 * * 1-5", timeZone: tz }, tz)).toBe("every weekday at 9am");
    expect(plainSchedule({ type: "cron", expression: "0 10 * * 1,3,5", timeZone: tz }, tz)).toBe("mon/wed/fri at 10am");
    expect(plainSchedule({ type: "cron", expression: "*/15 * * * *", timeZone: tz }, tz)).toBe("every 15 minutes");
    expect(plainSchedule({ type: "cron", expression: "0 * * * *", timeZone: tz }, tz)).toBe("every hour");
    expect(plainSchedule({ type: "cron", expression: "*/10 9-17 * * 1-5", timeZone: tz }, tz)).toBe("every 10 minutes, 9am–5:59pm, weekdays");
    expect(plainSchedule({ type: "cron", expression: "30 8 * * *", timeZone: tz }, tz)).toBe("every day at 8:30am");
    expect(plainSchedule({ type: "cron", expression: "0 9 1 * *", timeZone: tz }, tz)).toBe("monthly on the 1st at 9am");
    expect(plainSchedule({ type: "cron", expression: "0 9 L * *", timeZone: tz }, tz)).toBe("the last day of each month at 9am");
    expect(plainSchedule({ type: "cron", expression: "0 9 * * MON#2", timeZone: tz }, tz)).toBe("the second monday of each month at 9am");
    expect(plainSchedule({ type: "cron", expression: "0 9 * * 5#L", timeZone: tz }, tz)).toBe("the last friday of each month at 9am");
    expect(plainSchedule({ type: "cron", expression: "0 9 25 12 *", timeZone: tz }, tz)).toBe("every year on dec 25 at 9am");
  });

  it("names a cron zone only when it is not this computer's", () => {
    expect(plainSchedule({ type: "cron", expression: "0 9 * * *", timeZone: "UTC" }, tz)).toBe("every day at 9am (UTC)");
  });

  it("falls back to the exact expression it cannot say plainly", () => {
    expect(plainSchedule({ type: "cron", expression: "5,35 9-17/2 * * *", timeZone: tz }, tz)).toBe("custom schedule: 5,35 9-17/2 * * *");
  });
});
