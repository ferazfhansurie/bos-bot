import { describe, expect, it } from "vitest";
import { FIRST_TASKS, initialOnboardingState, nextOnboardingState, onboardingScript } from "./onboarding-chat";

const at = () => new Date("2026-10-08T00:00:00Z");

describe("onboarding chat", () => {
  it("greets, asks for a sign-in, then offers apps and finishes on a connection", () => {
    let s = initialOnboardingState("b", "t", "BOS", false);
    s = nextOnboardingState(s, { type: "start" });
    expect(s.step).toBe("engine");
    s = nextOnboardingState(s, { type: "engine-ready" });
    expect(s.step).toBe("apps");
    s = nextOnboardingState(s, { type: "connected", app: "gmail" }, at);
    expect([s.step, s.connected, s.completedAt]).toEqual(["done", ["gmail"], "2026-10-08T00:00:00.000Z"]);
  });
  it("goes straight to apps when an engine is ready, and ignores retries", () => {
    const s = nextOnboardingState(initialOnboardingState("b", "t", "BOS", true), { type: "start" });
    expect(s.step).toBe("apps");
    expect(nextOnboardingState(s, { type: "start" })).toBe(s);
    expect(nextOnboardingState(s, { type: "name", value: "Again" })).toBe(s);
  });
  it("holds setup open on a message typed before sign-in, and finishes on one after", () => {
    const signedOut = nextOnboardingState(initialOnboardingState("b", "t", "BOS", false), { type: "start" });
    expect(nextOnboardingState(signedOut, { type: "first-task", prompt: "hi" }, at)).toBe(signedOut);
    const ready = nextOnboardingState(signedOut, { type: "engine-ready" });
    expect(nextOnboardingState(ready, { type: "first-task", prompt: "hi" }, at).step).toBe("done");
  });
  it("passing on apps ends setup", () => {
    const s = nextOnboardingState(initialOnboardingState("b", "t", "BOS", true), { type: "start" });
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
