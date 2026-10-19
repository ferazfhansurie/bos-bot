import { describe, expect, it } from "vitest";
import {
  HELLO, ONBOARDING_FLOW_VERSION, businessType, detectLang, flowScript, initialFlowState, jobsFor, nextFlowState,
  profileRows, setupPrompt, teamCard, teamFor, teammateSoul, TEAMMATES, TIME_SINKS, type FlowState,
} from "./onboarding-flow";

const now = () => new Date("2026-10-18T01:00:00Z");
function run(events: Parameters<typeof nextFlowState>[1][]): FlowState {
  return events.reduce(nextFlowState, initialFlowState(now));
}
const answered = () => run([
  { type: "answer", step: "hello", text: "kenny hills bakers" },
  { type: "answer", step: "q1", text: "sourdough and pastries", pick: ["under rm100"] },
  { type: "answer", step: "q2", pick: ["locals nearby"], text: "bukit tunku, kl" },
  { type: "answer", step: "q3", pick: ["instagram", "walk-in", "telegram"] },
  { type: "answer", step: "q4", pick: ["content", "enquiries", "reports"] },
  { type: "answer", step: "q5", pick: ["en", "rule"] },
]);

describe("onboarding flow v3", () => {
  it("starts at hello as chief of staff", () => {
    const s = initialFlowState(now);
    expect(s.version).toBe(ONBOARDING_FLOW_VERSION);
    expect(s.step).toBe("hello");
    expect(HELLO).toContain("chief of staff");
    expect(flowScript(s)[0].card?.kind).toBe("input");
  });

  it("walks the five questions to the profile card", () => {
    const s = answered();
    expect(s.step).toBe("profile");
    expect(s.answers.channels).toEqual(["instagram", "walk-in"]);
    expect(s.answers.timeSinks).toEqual(["content", "enquiries"]);
    expect(s.answers.rules[0]).toMatch(/never send, post, spend or delete/);
    const script = flowScript(s);
    expect(script.at(-1)?.card?.kind).toBe("profile");
    expect(script.filter(m => m.who === "me")).toHaveLength(6);
    expect(profileRows(s).find(r => r.key === "area")?.value).toBe("bukit tunku, kl");
  });

  it("ignores out-of-order and retried taps", () => {
    const s = run([{ type: "answer", step: "hello", text: "x" }]);
    expect(nextFlowState(s, { type: "answer", step: "hello", text: "y" })).toBe(s);
    expect(nextFlowState(s, { type: "setup-done" })).toBe(s);
  });

  it("skips one step or everything", () => {
    const one = run([{ type: "answer", step: "hello", text: "x" }, { type: "skip" }]);
    expect(one.step).toBe("q2");
    const all = run([{ type: "answer", step: "hello", text: "x" }, { type: "skip-all" }]);
    expect(all.step).toBe("engine");
    const script = flowScript(all);
    expect(script.some(m => m.step === "q2")).toBe(false);
    expect(script.at(-1)?.card?.kind).toBe("engine");
  });

  it("unticking the default rule drops it", () => {
    const s = run([{ type: "answer", step: "hello", text: "x" }, { type: "skip" }, { type: "skip" }, { type: "skip" }, { type: "skip" }, { type: "answer", step: "q5", pick: ["bm"], text: "jangan reply customer lepas 10 malam" }]);
    expect(s.lang).toBe("bm");
    expect(s.answers.rules).toEqual(["jangan reply customer lepas 10 malam"]);
  });

  it("moves through engine, setup, team, jobs and check-in", () => {
    let s = nextFlowState(answered(), { type: "profile-ok" });
    expect(s.step).toBe("engine");
    s = nextFlowState(s, { type: "engine-ready" });
    s = nextFlowState(s, { type: "setup-done" });
    expect(s.step).toBe("team");
    s = nextFlowState(s, { type: "hire", teammates: ["content", "bogus"] });
    expect(s.team).toEqual(["content"]);
    expect(s.step).toBe("jobs");
    s = nextFlowState(s, { type: "job-done" });
    s = nextFlowState(s, { type: "checkin-shown" });
    expect(s.step).toBe("done");
  });

  it("detects bm, english and rojak", () => {
    expect(detectLang("kedai kek dekat shah alam")).toBe("bm");
    expect(detectLang("we sell cakes to families in kl")).toBe("en");
    expect(detectLang("kita jual cakes for the families dekat kl")).toBe("rojak");
    expect(detectLang("kenny hills bakers")).toBe("en");
  });

  it("speaks bm once they answer in bm", () => {
    const s = run([{ type: "answer", step: "hello", text: "kedai kek kak ros" }]);
    expect(s.lang).toBe("bm");
    expect(flowScript(s).at(-1)?.text).toMatch(/kau jual apa/);
  });

  it("classifies common malaysian businesses", () => {
    expect(businessType({ business: "kenny hills bakers", sell: "sourdough" })).toBe("food");
    expect(businessType({ business: "cool air", sell: "aircond servicing" })).toBe("home");
    expect(businessType({ business: "x", sell: "tuition for spm" })).toBe("education");
    expect(businessType({ business: "x", sell: "consulting" })).toBe("service");
  });

  it("builds the team from the time sinks", () => {
    expect(teamFor(["quotes", "content", "reports"])).toEqual(["followup", "content"]);
    for (const t of TIME_SINKS) expect(TEAMMATES[t.teammate]).toBeTruthy();
    const card = teamCard(answered());
    expect(card?.card.kind).toBe("team");
    if (card?.card.kind === "team") expect(card.card.options.map(o => o.id)).toEqual(["all", "first", "later"]);
    expect(teamCard(initialFlowState(now))).toBeNull();
  });

  it("gives three job cards tied to the time sink", () => {
    const s = { ...answered(), team: ["content"] };
    const jobs = jobsFor(s);
    expect(jobs).toHaveLength(3);
    expect(jobs[0].who).toBe("content");
    expect(jobs[2].sink).toBe("enquiries");
    expect(jobs[2].who).toBe("bos");
    expect(jobsFor(initialFlowState(now))).toHaveLength(3);
  });

  it("prompts ask for sources and forbid invented facts", () => {
    const p = setupPrompt(answered(), {});
    expect(p).toContain("bos/soul.md");
    expect(p).toContain("what i couldn't find");
    expect(p).toContain("```profile");
    const soul = teammateSoul("content", answered());
    expect(soul).toContain("kenny hills bakers");
    expect(soul).toContain("no connected accounts");
  });
});
