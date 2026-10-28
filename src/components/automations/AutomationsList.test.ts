import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { Bot } from "@/state/store";
import type { Routine, RoutineRun } from "@/lib/routines";

vi.mock("@/state/store", () => ({
  useStore: () => ({ state: { selectedId: "bot-2", routinesLoadState: "ready" }, dispatch: vi.fn() }),
  defaultBotId: (bots: Array<{ id: string }>) => bots[0]?.id ?? "",
  api: vi.fn(),
}));

const { AutomationsList, automationRequestText, preferredAutomationBot } = await import("./AutomationsList");

function makeBot(id: string, name: string, extra: Partial<Bot> = {}): Bot {
  return {
    id,
    threadId: `thread-${id}`,
    name,
    title: name,
    description: "",
    notifications: false,
    color: "green",
    unread: false,
    modelSelection: { instanceId: "local", model: "test-model" },
    messages: [],
    ...extra,
  };
}

const scout = makeBot("bot-1", "Scout");
const ledger = makeBot("bot-2", "Ledger");
const ghost = makeBot("bot-3", "Ghost", { hidden: true });

const routine: Routine = {
  id: "r1",
  name: "Morning brief",
  prompt: "Summarize what is on my plate today",
  target: "bot",
  botId: scout.id,
  runOn: "maus",
  enabled: true,
  schedule: { type: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
  durationMinutes: 5,
  nextRunAt: Date.UTC(2026, 9, 27, 1),
  createdAt: 0,
  updatedAt: 0,
};

const run: RoutineRun = {
  id: "run-1",
  routineId: routine.id,
  routineName: routine.name,
  botId: scout.id,
  target: "bot",
  runOn: "maus",
  manual: false,
  status: "completed",
  scheduledFor: Date.UTC(2026, 9, 26, 1),
  startedAt: Date.UTC(2026, 9, 26, 1),
  finishedAt: Date.UTC(2026, 9, 26, 1, 2),
  createdAt: Date.UTC(2026, 9, 26, 1),
} as unknown as RoutineRun;

describe("automation request helpers", () => {
  it("prefixes the request in plain words", () => {
    expect(automationRequestText("  every morning tell me yesterday's sign-ups ")).toBe("set up an automation: every morning tell me yesterday's sign-ups");
  });

  it("prefers the selected visible bot, else the default", () => {
    expect(preferredAutomationBot([scout, ledger], "bot-2")).toBe("bot-2");
    expect(preferredAutomationBot([scout, ledger, ghost], "bot-3")).toBe("bot-1");
    expect(preferredAutomationBot([scout, ledger], null)).toBe("bot-1");
    expect(preferredAutomationBot([], "bot-1")).toBe("");
  });
});

describe("AutomationsList", () => {
  const noop = () => {};

  it("shows a card with mascot, plain schedule, bot, instructions, last run and a switch", () => {
    const html = renderToStaticMarkup(createElement(AutomationsList, {
      routines: [routine], runs: [run], bots: [scout, ledger], onOpen: noop, onNew: noop, onTemplate: noop,
    }));
    expect(html).toContain("Morning brief");
    expect(html).toContain("every weekday at 9am");
    expect(html).toContain("Scout");
    expect(html).toContain("Summarize what is on my plate today");
    expect(html).toContain("Last run: completed");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Pause Morning brief"');
  });

  it("asks what should happen and defaults the picker to the selected bot", () => {
    const html = renderToStaticMarkup(createElement(AutomationsList, {
      routines: [], runs: [], bots: [scout, ledger], onOpen: noop, onNew: noop,
    }));
    expect(html).toContain("What should happen, and when?");
    expect(html).toMatch(/<option value="bot-2" selected="">Ledger<\/option>/);
  });

  it("shows the eight templates when asked to", () => {
    const html = renderToStaticMarkup(createElement(AutomationsList, {
      routines: [], runs: [], bots: [scout], onOpen: noop, onNew: noop, onTemplate: noop,
    }));
    for (const title of ["Morning brief", "Lead follow-up", "Weekly report", "Inbox triage", "End-of-day summary", "Daily sign-ups check", "Weekly invoice chase", "Competitor watch"]) {
      expect(html).toContain(title);
    }
  });

  it("has a one-button empty state", () => {
    const html = renderToStaticMarkup(createElement(AutomationsList, {
      routines: [], runs: [], bots: [scout], ask: false, onOpen: noop, onNew: noop,
    }));
    expect(html).toContain("No automations yet.");
    expect(html).toContain("New automation");
    expect(html).not.toContain("What should happen, and when?");
  });

  it("shows a paused automation switched off", () => {
    const html = renderToStaticMarkup(createElement(AutomationsList, {
      routines: [{ ...routine, enabled: false }], runs: [], bots: [scout], ask: false, onOpen: noop, onNew: noop,
    }));
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("Not run yet");
    expect(html).toContain('aria-label="Turn on Morning brief"');
  });
});
