import { describe, expect, it } from "vitest";
import { LiveTitles, fallbackTitle, shortTitle, usableThreadTitle } from "./live-title.ts";

describe("fallbackTitle", () => {
  it("cleans the job's message down to five words", () => {
    expect(fallbackTitle("[Thread you opened yourself from #voice · Make voice v3 call me back when. The request below is your own words]\nfix the lock screen card so it shows the real step")).toBe("fix the lock screen card…");
    expect(fallbackTitle("Check bosbot.my health.")).toBe("check bosbot.my health");
    expect(fallbackTitle("sent from a live voice call: lead with the outcome. Make voice v3 call me back")).toBe("make voice v3 call me…");
    expect(fallbackTitle("   ")).toBeUndefined();
  });
});

describe("thread titles", () => {
  it("uses a short stored name and skips first-message snippets", () => {
    expect(usableThreadTitle("Live card redesign")).toBe("Live card redesign");
    expect(usableThreadTitle("i think the rest of our ad budget we should run…")).toBeUndefined();
    expect(shortTitle("\"Fix lock screen card.\"")).toBe("fix lock screen card");
    expect(shortTitle("this is far too many words to be a title for a card")).toBeUndefined();
  });
});

describe("LiveTitles", () => {
  it("asks the model once per job and redraws when it answers", async () => {
    let calls = 0;
    let redraws = 0;
    const titles = new LiveTitles({
      threadTitle: () => "i think the rest of our ad budget we should run…",
      jobMessage: () => "i think the rest of our ad budget we should run whatsapp ai crm ads",
      generate: () => async () => { calls += 1; return "WhatsApp CRM ads plan"; },
      ready: () => { redraws += 1; },
    });
    expect(titles.title("b", "t", 100)).toBe("i think the rest of…");
    expect(titles.title("b", "t", 100)).toBe("i think the rest of…");
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(titles.title("b", "t", 100)).toBe("whatsapp crm ads plan");
    expect(calls).toBe(1);
    expect(redraws).toBe(1);
    titles.title("b", "t", 500); // a new job asks again
    expect(calls).toBe(2);
  });
});
