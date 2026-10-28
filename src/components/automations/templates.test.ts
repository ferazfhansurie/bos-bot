import { describe, expect, it } from "vitest";
import { AUTOMATION_TEMPLATES, nextTemplateRun } from "./templates";

describe("automation templates", () => {
  it("offers the eight starters with unique ids", () => {
    expect(AUTOMATION_TEMPLATES).toHaveLength(8);
    expect(new Set(AUTOMATION_TEMPLATES.map((template) => template.id)).size).toBe(8);
    expect(AUTOMATION_TEMPLATES.map((template) => template.id)).toEqual([
      "morning-brief",
      "lead-follow-up",
      "weekly-report",
      "inbox-triage",
      "end-of-day",
      "daily-signups",
      "invoice-chase",
      "competitor-watch",
    ]);
  });

  it("gives every starter a name, instructions and a valid schedule", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.name.trim()).not.toBe("");
      expect(template.title.trim()).not.toBe("");
      expect(template.instructions.trim().length).toBeGreaterThan(40);
      expect(template.schedule.time).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
      expect(template.schedule.weekdays.length).toBeGreaterThan(0);
      for (const day of template.schedule.weekdays) expect(day).toBeGreaterThanOrEqual(0);
      for (const day of template.schedule.weekdays) expect(day).toBeLessThanOrEqual(6);
    }
  });

  it("never invents data: no digits beyond counts in the instructions", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      expect(template.instructions).not.toMatch(/\d/);
      expect(template.instructions).not.toMatch(/@|https?:/);
    }
  });

  it("drafts outbound messages instead of sending them", () => {
    for (const id of ["lead-follow-up", "invoice-chase"]) {
      const template = AUTOMATION_TEMPLATES.find((item) => item.id === id)!;
      expect(template.instructions).toMatch(/do not send/i);
    }
  });
});

describe("nextTemplateRun", () => {
  it("picks the next matching weekday slot", () => {
    // Saturday 2026-10-24 12:00 local → next weekday 09:00 is Monday 26th
    const saturdayNoon = new Date(2026, 9, 24, 12, 0).getTime();
    const at = new Date(nextTemplateRun({ type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] }, saturdayNoon));
    expect([at.getFullYear(), at.getMonth(), at.getDate(), at.getHours(), at.getMinutes()]).toEqual([2026, 9, 26, 9, 0]);
  });

  it("uses today when the time has not passed yet", () => {
    const mondayEarly = new Date(2026, 9, 26, 7, 0).getTime();
    const at = new Date(nextTemplateRun({ type: "daily", time: "08:30", weekdays: [1, 2, 3, 4, 5] }, mondayEarly));
    expect([at.getDate(), at.getHours(), at.getMinutes()]).toEqual([26, 8, 30]);
  });
});
