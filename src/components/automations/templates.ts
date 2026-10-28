// Starter automations for people who have never written a schedule. Tapping one
// opens the normal editor prefilled, so nothing runs until the person saves.
// Instructions are deliberately generic: no invented names, numbers or tools —
// the bot asks for what it does not have instead of making it up.
import type { RoutineSchedule } from "@/lib/routines";

export type AutomationTemplateIcon =
  | "sunrise"
  | "user-check"
  | "bar-chart"
  | "inbox"
  | "moon"
  | "user-plus"
  | "receipt"
  | "eye";

export type AutomationTemplate = {
  id: string;
  title: string;
  blurb: string;
  icon: AutomationTemplateIcon;
  /** The routine's name once saved. */
  name: string;
  instructions: string;
  schedule: Extract<RoutineSchedule, { type: "daily" }>;
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: "morning-brief",
    title: "Morning brief",
    blurb: "A short rundown before the day starts",
    icon: "sunrise",
    name: "Morning brief",
    instructions:
      "Give me a short morning brief: what is on my plate today, anything that came in overnight that needs me, and the one thing I should do first. Keep it under ten lines. If you cannot reach something you need, say so instead of guessing.",
    schedule: { type: "daily", time: "08:30", weekdays: WEEKDAYS },
  },
  {
    id: "lead-follow-up",
    title: "Lead follow-up",
    blurb: "Spot leads waiting on a reply",
    icon: "user-check",
    name: "Lead follow-up",
    instructions:
      "Look through my recent leads and conversations for anyone still waiting on a reply from us. List each one with when they last heard from us, and draft a short, friendly follow-up for each. Do not send anything; I will review the drafts first.",
    schedule: { type: "daily", time: "10:00", weekdays: WEEKDAYS },
  },
  {
    id: "weekly-report",
    title: "Weekly report",
    blurb: "What happened this week, in one page",
    icon: "bar-chart",
    name: "Weekly report",
    instructions:
      "Write a short weekly report: what got done this week, what is still open, and anything that needs a decision next week. Use only what you can actually see in my apps and our conversations; leave out anything you are not sure of.",
    schedule: { type: "daily", time: "16:00", weekdays: [5] },
  },
  {
    id: "inbox-triage",
    title: "Inbox triage",
    blurb: "Sort new email into what needs you",
    icon: "inbox",
    name: "Inbox triage",
    instructions:
      "Go through my new email since the last run. Group it into: needs my reply, worth reading, and can be ignored. For anything that needs a reply, write one line on what it is about. Do not reply to, archive or delete anything.",
    schedule: { type: "daily", time: "09:00", weekdays: WEEKDAYS },
  },
  {
    id: "end-of-day",
    title: "End-of-day summary",
    blurb: "Wrap up the day and line up tomorrow",
    icon: "moon",
    name: "End-of-day summary",
    instructions:
      "Summarise my day: what got done, what is still open, and anything I promised someone. Then suggest the first three things for tomorrow. Keep it short.",
    schedule: { type: "daily", time: "17:30", weekdays: WEEKDAYS },
  },
  {
    id: "daily-signups",
    title: "Daily sign-ups check",
    blurb: "Yesterday's new sign-ups at a glance",
    icon: "user-plus",
    name: "Daily sign-ups check",
    instructions:
      "Tell me how many new sign-ups came in yesterday and how that compares with the day before, with anything unusual worth a look. If you do not have access to where sign-ups are recorded, tell me what you need instead of guessing a number.",
    schedule: { type: "daily", time: "09:00", weekdays: EVERY_DAY },
  },
  {
    id: "invoice-chase",
    title: "Weekly invoice chase",
    blurb: "Find unpaid invoices and draft reminders",
    icon: "receipt",
    name: "Weekly invoice chase",
    instructions:
      "Find invoices that are unpaid or past due. List each one with who owes it, the amount and how late it is, and draft a polite reminder for each. Do not send anything; I will review the drafts first.",
    schedule: { type: "daily", time: "10:00", weekdays: [1] },
  },
  {
    id: "competitor-watch",
    title: "Competitor watch",
    blurb: "What competitors changed this week",
    icon: "eye",
    name: "Competitor watch",
    instructions:
      "Check what my competitors have changed or announced in the past week, such as pricing, new products or campaigns, and tell me what matters for us. If you do not know who my competitors are yet, ask me before searching.",
    schedule: { type: "daily", time: "09:00", weekdays: [1] },
  },
];

/** The first local time at or after `now` that a daily-style schedule would
 * fire, so the editor opens on a real upcoming slot. */
export function nextTemplateRun(schedule: AutomationTemplate["schedule"], now = Date.now()): number {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days = schedule.weekdays.length > 0 ? schedule.weekdays : EVERY_DAY;
  const start = new Date(now);
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, hour ?? 9, minute ?? 0, 0, 0);
    if (candidate.getTime() >= now && days.includes(candidate.getDay())) return candidate.getTime();
  }
  return now;
}
