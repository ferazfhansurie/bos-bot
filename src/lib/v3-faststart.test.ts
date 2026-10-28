import { describe, expect, it } from "vitest";
import { fastStartInChat, fastStartOnHome, firstVisit, hasPreparedGreeting, readingLabel } from "./v3-faststart";

const config = { onboarding: { chat: { threadId: "t1" } } };
const greet = { role: "bot" as const, onboarding: { step: "greet" as const, text: "hi", card: { kind: "suggestions" as const, items: [{ id: "inbox", title: "Inbox", prompt: "x" }] } } };
const prepared = { role: "bot" as const, onboarding: { step: "greet" as const, text: "hi", card: { kind: "suggestions" as const, items: [{ id: "prepared", title: "Job", prompt: "x" }] } } };
const user = { role: "user" as const };

describe("v3 faststart placement", () => {
  it("offers the start in bos's first conversation until the person writes or the greeting reads their business", () => {
    expect(fastStartInChat(config, "t1", [greet])).toBe(true);
    expect(fastStartInChat(config, "t2", [greet])).toBe(false);
    expect(fastStartInChat(config, "t1", [greet, user])).toBe(false);
    expect(fastStartInChat(config, "t1", [prepared])).toBe(false);
    expect(fastStartInChat(null, "t1", [greet])).toBe(false);
    expect(hasPreparedGreeting([greet])).toBe(false);
  });

  it("keeps the web's first visit bare until the first message, and never on desktop", () => {
    expect(firstVisit(true, config, "t1", [prepared])).toBe(true);
    expect(firstVisit(true, config, "t1", [prepared, user])).toBe(false);
    expect(firstVisit(false, config, "t1", [greet])).toBe(false);
  });

  it("puts it on the home board only before there is a team", () => {
    expect(fastStartOnHome([{}])).toBe(true);
    expect(fastStartOnHome([{}, { hidden: true }, { remote: true }])).toBe(true);
    expect(fastStartOnHome([{}, {}])).toBe(false);
  });

  it("names what it is reading", () => {
    expect(readingLabel("www.kekana.my/menu")).toBe("kekana.my");
    expect(readingLabel("https://instagram.com/kedaikek?x=1")).toBe("@kedaikek");
    expect(readingLabel("@kedaikek")).toBe("@kedaikek");
  });
});
