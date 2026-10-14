import { beforeEach, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { DATA_DIR, saveConfig } from "./config.ts";
import { Store } from "./store.ts";
import { onboardingMarketer, MARKETER_STARTER } from "./onboarding-marketer.ts";
beforeEach(() => rmSync(DATA_DIR, { recursive: true, force: true }));
const selection = { instanceId: "fixture", model: "fixture" };
const make = () => new Store(() => selection);

it("creates a clean private Ask marketer even under a Full workspace default", () => {
  saveConfig({ approvals: { defaultMode: "full" } });
  const store = make();
  const original = store.createBot({ name: "money", soul: "private owner data", modelSelection: { instanceId: "other", model: "other" } });
  const before = JSON.stringify(original);
  const marketer = onboardingMarketer(store, 3, selection);
  expect(marketer.id).not.toBe(original.id);
  expect(JSON.stringify(original)).toBe(before);
  expect(marketer.soul).toBe(MARKETER_STARTER.soul);
  expect(marketer.soul).not.toContain("private owner data");
  expect(marketer.visibility).toBe("private");
  expect(marketer.approvalMode).toBe("ask");
  expect(marketer.tasks?.[0].approvalMode).toBe("ask");
  expect(marketer.autoApprove).toBe(false);
  expect(marketer.approvePeerComms).toBe(false);
  expect(marketer.composio).toBe(false);
  expect(marketer.chiefOfStaff).not.toBe(true);
  expect(marketer.resumeCursors).toEqual({});
  expect(marketer.modelSelection).toEqual(selection);
});

it("reuses the exact persisted bot, conversation and provider after retry/restart at capacity", () => {
  const store = make();
  const marketer = onboardingMarketer(store, 1, selection);
  store.appendMessage(marketer.threadId, { role: "user", kind: "text", text: "my business intake" });
  const restarted = make();
  const again = onboardingMarketer(restarted, 1, { instanceId: "different", model: "different" });
  expect(again.id).toBe(marketer.id);
  expect(again.threadId).toBe(marketer.threadId);
  expect(again.modelSelection).toEqual(selection);
  expect(restarted.bots).toHaveLength(1);
  expect(restarted.messagesFor(again.threadId).map(message => message.text)).toContain("my business intake");
});

it("does not mutate or duplicate an intentionally hidden/shared marketer", () => {
  const store = make();
  const marketer = onboardingMarketer(store, 2, selection);
  store.patchBot(marketer.id, { visibility: "shared" });
  const before = JSON.stringify(store.bots);
  expect(() => onboardingMarketer(store, 2, selection)).toThrow(/private/);
  expect(JSON.stringify(store.bots)).toBe(before);
});

it("rolls back bot and offer receipt together on disk failure", () => {
  const store = make();
  const saving = vi.spyOn(store as any, "saveBots").mockImplementationOnce(() => { throw new Error("fixture disk full"); });
  expect(() => onboardingMarketer(store, 1, selection)).toThrow("fixture disk full");
  expect(store.bots).toHaveLength(0);
  expect(make().bots).toHaveLength(0);
  saving.mockRestore();
  const saved = onboardingMarketer(store, 1, selection);
  expect(onboardingMarketer(make(), 1, selection).id).toBe(saved.id);
});

it("refuses capacity before creating an offer", () => {
  const store = make();store.createBot({ name: "existing" });
  expect(() => onboardingMarketer(store, 1, selection)).toThrow(/limit/);
  expect(store.bots).toHaveLength(1);
});

it("pins the original offer receipt after changing the active thread and default model",()=>{
  const store=make();const bot=onboardingMarketer(store,2,selection,"original business brief");
  const receipt=structuredClone(bot.onboardingOfferAssignment);
  store.createTask(bot.id,"another task");
  store.patchBot(bot.id,{modelSelection:{instanceId:"new",model:"new"}});
  const resumed=onboardingMarketer(make(),2,selection,"changed brief");
  expect(resumed.threadId).not.toBe(receipt?.threadId);
  expect(resumed.onboardingOfferAssignment).toEqual(receipt);
});
