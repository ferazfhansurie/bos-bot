// How an automation card says when it runs, in the words a person would use:
// "every weekday at 9am", "every 15 minutes", "mon/wed/fri at 10am". Display
// only — the scheduler never reads this, and anything it cannot say plainly
// falls back to the exact cron expression rather than guessing a meaning.
import type { RoutineSchedule } from "@/lib/routines";

const DAY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const DAY_LONG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTH = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] as const;

/** 9:00 → "9am", 13:30 → "1:30pm", 0:00 → "12am". */
export function plainTime(hour: number, minute: number): string {
  const suffix = hour < 12 ? "am" : "pm";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${twelve}${suffix}` : `${twelve}:${String(minute).padStart(2, "0")}${suffix}`;
}

function wallTime(time: string): string {
  const [hour, minute] = time.split(":").map(Number);
  return Number.isFinite(hour) && Number.isFinite(minute) ? plainTime(hour!, minute!) : time;
}

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** [1,2,3,4,5] → "every weekday", [1,3,5] → "mon/wed/fri". */
export function plainDays(days: readonly number[]): string {
  const sorted = [...new Set(days.map((day) => ((day % 7) + 7) % 7))].sort((a, b) => a - b);
  if (sorted.length === 0 || sorted.length === 7) return "every day";
  const key = sorted.join(",");
  if (key === "1,2,3,4,5") return "every weekday";
  if (key === "0,6") return "every weekend";
  if (sorted.length === 1) return `every ${DAY_LONG[sorted[0]!]}`;
  return sorted.map((day) => DAY[day]).join("/");
}

/** The day set as a trailing qualifier: "weekdays", "mondays", "mon/wed/fri". */
function daysQualifier(days: readonly number[]): string {
  const words = plainDays(days);
  if (words === "every day") return "";
  return words.startsWith("every ") ? `${words.slice(6)}s` : words;
}

function plainMinutes(minutes: number): string {
  if (minutes === 60) return "every hour";
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`;
  if (minutes < 60) return `every ${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return `every ${hours} hour${hours === 1 ? "" : "s"} ${minutes % 60} minutes`;
}

function plainDate(at: number): string {
  const date = new Date(at);
  return `${DAY[date.getDay()]} ${date.getDate()} ${MONTH[date.getMonth()]}`;
}

/** One cron field of plain numbers, ranges and lists → the weekday set, or null. */
function cronWeekdays(field: string): number[] | null {
  const named: Record<string, number> = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
  const value = (token: string) => {
    const upper = token.toUpperCase();
    if (upper in named) return named[upper]!;
    return /^[0-7]$/.test(token) ? Number(token) % 7 : null;
  };
  const days = new Set<number>();
  for (const part of field.split(",")) {
    const range = part.split("-");
    if (range.length === 1) {
      const day = value(part);
      if (day === null) return null;
      days.add(day);
    } else if (range.length === 2) {
      const from = value(range[0]!);
      // "5-7" ends on Sunday as 7; keep it as 7 for the walk, then wrap.
      const toRaw = range[1]!.toUpperCase() in named ? named[range[1]!.toUpperCase()]! : /^[0-7]$/.test(range[1]!) ? Number(range[1]) : null;
      if (from === null || toRaw === null || toRaw < from) return null;
      for (let day = from; day <= toRaw; day += 1) days.add(day % 7);
    } else return null;
  }
  return [...days];
}

function plainCron(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const number = (field: string, max: number) => /^\d+$/.test(field) && Number(field) <= max ? Number(field) : null;

  // every N minutes / every hour, optionally inside an hour window and on some days
  const step = /^\*\/(\d+)$/.exec(minute);
  if ((step || minute === "*" || number(minute, 59) !== null) && day === "*" && month === "*") {
    const minuteStep = step ? Number(step[1]) : minute === "*" ? 1 : null;
    const hourWindow = /^(\d+)-(\d+)$/.exec(hour);
    const hourStep = /^\*\/(\d+)$/.exec(hour);
    let cadence: string | null = null;
    let window = "";
    if (minuteStep !== null && minuteStep > 0 && (hour === "*" || hourWindow)) {
      cadence = minuteStep === 1 ? "every minute" : plainMinutes(minuteStep);
    } else if (minuteStep === null && hour === "*") {
      cadence = "every hour";
    } else if (minuteStep === null && hourStep && Number(hourStep[1]) > 0) {
      cadence = plainMinutes(Number(hourStep[1]) * 60);
    }
    if (cadence) {
      if (hourWindow) {
        const from = Number(hourWindow[1]);
        const to = Number(hourWindow[2]);
        if (from > 23 || to > 23 || to < from) return null;
        window = `, ${plainTime(from, 0)}–${plainTime(to, 59)}`;
      }
      if (weekday === "*") return `${cadence}${window}`;
      const days = cronWeekdays(weekday);
      if (!days) return null;
      const qualifier = daysQualifier(days);
      return qualifier ? `${cadence}${window}, ${qualifier}` : `${cadence}${window}`;
    }
  }

  const m = number(minute, 59);
  const h = number(hour, 23);
  if (m === null || h === null) return null;
  const time = plainTime(h, m);
  if (day === "*" && month === "*") {
    if (weekday === "*") return `every day at ${time}`;
    const days = cronWeekdays(weekday);
    if (days) return `${plainDays(days)} at ${time}`;
    const nth = /^([0-7]|SUN|MON|TUE|WED|THU|FRI|SAT)#([1-5]|L)$/i.exec(weekday);
    const nthDay = nth ? cronWeekdays(nth[1]!)?.[0] : undefined;
    if (nth && nthDay !== undefined) {
      const order = nth[2]!.toUpperCase() === "L" ? "last" : ["", "first", "second", "third", "fourth", "fifth"][Number(nth[2])];
      return `the ${order} ${DAY_LONG[nthDay]} of each month at ${time}`;
    }
    return null;
  }
  if (weekday !== "*") return null;
  if (day === "L" && month === "*") return `the last day of each month at ${time}`;
  const date = number(day, 31);
  if (date === null || date < 1) return null;
  if (month === "*") return `monthly on the ${ordinal(date)} at ${time}`;
  const monthNumber = number(month, 12);
  if (monthNumber === null || monthNumber < 1) return null;
  return `every year on ${MONTH[monthNumber - 1]} ${date} at ${time}`;
}

function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

/** The schedule in plain lowercase words. A cron zone that differs from this
 * computer's is named, since "9am" would otherwise read as local time. */
export function plainSchedule(schedule: RoutineSchedule, timeZone = localZone()): string {
  if (schedule.type === "once") {
    const date = new Date(schedule.at);
    return `once, ${plainDate(schedule.at)} at ${plainTime(date.getHours(), date.getMinutes())}`;
  }
  if (schedule.type === "daily") return `${plainDays(schedule.weekdays)} at ${wallTime(schedule.time)}`;
  if (schedule.type === "interval") {
    const details: string[] = [];
    if (schedule.window) details.push(`${wallTime(schedule.window.start)}–${wallTime(schedule.window.end)}`);
    const qualifier = schedule.weekdays && schedule.weekdays.length > 0 ? daysQualifier(schedule.weekdays) : "";
    if (qualifier) details.push(qualifier);
    if (schedule.endsAt != null) details.push(`until ${plainDate(schedule.endsAt)}`);
    return [plainMinutes(schedule.everyMinutes), ...details].join(", ");
  }
  const zone = schedule.timeZone && schedule.timeZone !== timeZone ? ` (${schedule.timeZone})` : "";
  const words = plainCron(schedule.expression);
  return words ? `${words}${zone}` : `custom schedule: ${schedule.expression.trim()}${zone}`;
}
