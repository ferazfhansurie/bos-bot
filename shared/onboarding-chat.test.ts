import { describe, expect, it } from "vitest";
import { initialOnboardingState, nextOnboardingState, onboardingScript } from "./onboarding-chat";

const at = () => new Date("2026-10-08T00:00:00Z");

describe("onboarding chat", () => {
  it("walks greet, name, engine, apps, first task", () => {
    let s = initialOnboardingState("b", "t", "BOS", false);
    s = nextOnboardingState(s, { type: "start" });
    expect(s.step).toBe("name");
    s = nextOnboardingState(s, { type: "name", value: "  Max   Power " });
    expect([s.step, s.botName]).toEqual(["engine", "Max Power"]);
    s = nextOnboardingState(s, { type: "engine-ready" });
    expect(s.step).toBe("apps");
    s = nextOnboardingState(s, { type: "connected", app: "gmail" });
    expect([s.step, s.connected]).toEqual(["first-task", ["gmail"]]);
    s = nextOnboardingState(s, { type: "first-task", prompt: "plan my week" }, at);
    expect([s.step, s.completedAt]).toEqual(["done", "2026-10-08T00:00:00.000Z"]);
  });
  it("skips the engine step when an engine is ready and ignores retries", () => {
    let s = nextOnboardingState(initialOnboardingState("b", "t", "BOS", true), { type: "start" });
    s = nextOnboardingState(s, { type: "name", value: "Bo" });
    expect(s.step).toBe("apps");
    expect(nextOnboardingState(s, { type: "name", value: "Again" })).toBe(s);
    expect(nextOnboardingState(s, { type: "name", value: "   " }).botName).toBe("Bo");
  });
  it("lets a typed message finish setup from any step", () => {
    const s = nextOnboardingState(initialOnboardingState("b", "t", "BOS", false), { type: "first-task", prompt: "hi" }, at);
    expect(s.step).toBe("done");
  });
  it("greets by first name and shows connect cards", () => {
    expect(onboardingScript("greet", { personName: "Firaz Hansurie", botName: "BOS", engineReady: true, connected: [] })[0].text).toContain("Hi Firaz, I'm BOS");
    const apps = onboardingScript("apps", { personName: "", botName: "BOS", engineReady: true, connected: ["gmail"] });
    expect(apps.filter(m => m.card?.kind === "connect").map(m => m.card)).toEqual([
      { kind: "connect", app: "gmail", connected: true }, { kind: "connect", app: "outlook", connected: false }]);
    expect(onboardingScript("engine", { personName: "", botName: "BOS", engineReady: true, connected: [] })).toEqual([]);
  });
});
