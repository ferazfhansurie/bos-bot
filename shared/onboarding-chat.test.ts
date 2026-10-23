import { describe, expect, it } from "vitest";
import { FIRST_TASKS, initialOnboardingState, nextOnboardingState, onboardingScript } from "./onboarding-chat";

const at = () => new Date("2026-10-08T00:00:00Z");

describe("onboarding chat", () => {
  it("offers the work-group starter with explicit group and routine review", () => {
    const task = FIRST_TASKS.find(task => task.id === "whatsapp-work-groups");
    expect(task).toBeDefined();
    expect(task?.prompt).toContain("choose which groups");
    expect(task?.prompt).toContain("review the schedule");
  });
  it("uses configured starters including an explicit empty list", () => {
    const ctx = { personName: "", botName: "BOS", engineReady: true, connected: [] as const, starterJobs: [{ id: "custom", title: "My job", prompt: "Draft a plan" }] };
    for (const step of ["greet", "first-task"] as const) {
      expect(onboardingScript(step, ctx)[0].card).toEqual({ kind: "suggestions", items: ctx.starterJobs });
      expect(onboardingScript(step, { ...ctx, starterJobs: [] })[0].card).toEqual({ kind: "suggestions", items: [] });
    }
  });
  it("offers BOS AI alongside existing subscriptions only when enabled", () => {
    const ctx = { personName: "", botName: "BOS", engineReady: false, connected: [] as const };
    expect(onboardingScript("engine", ctx)[0].text).toContain("BOS AI");
    expect(onboardingScript("engine", { ...ctx, freeEngine: false })[0].text).not.toContain("BOS AI");
  });
  it("greets, asks for a sign-in, and finishes once an engine is ready", () => {
    let s = initialOnboardingState("b", "t", "BOS", false);
    s = nextOnboardingState(s, { type: "start" });
    expect(s.step).toBe("engine");
    s = nextOnboardingState(s, { type: "engine-ready" }, at);
    expect([s.step, s.completedAt]).toEqual(["done", "2026-10-08T00:00:00.000Z"]);
  });
  it("finishes on start when an engine is ready, and ignores retries", () => {
    const s = nextOnboardingState(initialOnboardingState("b", "t", "BOS", true), { type: "start" }, at);
    expect([s.step, s.completedAt]).toEqual(["done", "2026-10-08T00:00:00.000Z"]);
    expect(nextOnboardingState(s, { type: "start" })).toBe(s);
    expect(nextOnboardingState(s, { type: "name", value: "Again" })).toBe(s);
  });
  it("holds setup open on a message typed before sign-in, and finishes on one after", () => {
    const signedOut = nextOnboardingState(initialOnboardingState("b", "t", "BOS", false), { type: "start" });
    expect(nextOnboardingState(signedOut, { type: "first-task", prompt: "hi" }, at)).toBe(signedOut);
    const ready = nextOnboardingState(signedOut, { type: "engine-ready" });
    expect(nextOnboardingState(ready, { type: "first-task", prompt: "hi" }, at).step).toBe("done");
  });
  it("a connection from an older record still on apps ends setup", () => {
    const s = { ...initialOnboardingState("b", "t", "BOS", true), step: "apps" as const };
    const next = nextOnboardingState(s, { type: "connected", app: "gmail" }, at);
    expect([next.step, next.connected]).toEqual(["done", ["gmail"]]);
    expect(nextOnboardingState(s, { type: "skip" }, at).step).toBe("done");
  });
  it("greets by first name with the starter jobs, and shows connect cards only when apps can work", () => {
    const greet = onboardingScript("greet", { personName: "Firaz Hansurie", botName: "BOS", engineReady: true, connected: [] });
    expect(greet).toHaveLength(1);
    expect(greet[0].text).toContain("Hi Firaz, I'm BOS");
    expect(greet[0].card).toEqual({ kind: "suggestions", items: FIRST_TASKS.map((task) => ({ ...task })) });
    expect(onboardingScript("greet", { personName: "", botName: "BOS", engineReady: true, connected: [] })[0].text).toMatch(/^Hi, I'm BOS/);
    const apps = onboardingScript("apps", { personName: "", botName: "BOS", engineReady: true, connected: ["gmail"] });
    expect(apps.filter(m => m.card?.kind === "connect").map(m => m.card)).toEqual([
      { kind: "connect", app: "gmail", connected: true }, { kind: "connect", app: "outlook", connected: false }]);
    expect(onboardingScript("apps", { personName: "", botName: "BOS", engineReady: true, connected: [], appsAvailable: false }).some(m => m.card)).toBe(false);
    expect(onboardingScript("engine", { personName: "", botName: "BOS", engineReady: true, connected: [] })).toEqual([]);
    expect(onboardingScript("engine", { personName: "", botName: "BOS", engineReady: false, connected: [] })[0].card).toEqual({ kind: "engine" });
  });
});
