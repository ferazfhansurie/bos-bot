import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { closeMessageDb } from "./message-db.ts";
import { Store } from "./store.ts";
import { applyDiscordHistory, planDiscordHistory } from "./discord-history-import.ts";

const ids = ["1528290901837746296", "1552216434053222400"];
const botIds = ["00000000-0000-4000-8000-000000000002", "a5cd9d23-e9e4-4745-8348-e786bf6787c2"];
const source = () => ({ version: 1, source: "fixture", exportedAt: 1, channels: ids.map((id, index) => ({
  channel: { guild_id: "1025253183716605962", channel_id: id, name: index ? "claude" : "chatgpt",
    conversation_key: `guild:1025253183716605962:channel:${id}`, created_at: 1 },
  messages: [
    { message_id: `${index + 1}`.padStart(19, "1"), body: "hello", received_at: 1000, role: "user", author_name: "Partner", delivery_state: "delivered" },
    { message_id: `${index + 2}`.padStart(19, "2"), body: "reply", received_at: 2000, role: "assistant", author_name: "AIOS", delivery_state: "delivered" },
  ],
})) });

describe("inert Partner Discord history import", () => {
  beforeEach(() => { closeMessageDb(); rmSync(DATA_DIR, { recursive: true, force: true }); });

  it("rejects malformed input and duplicate source IDs before writing", () => {
    const value = source();
    value.channels[0].messages[1].message_id = value.channels[0].messages[0].message_id;
    expect(() => planDiscordHistory(value)).toThrow(/Duplicate/);
    value.channels[0].messages[1].message_id = "bad";
    expect(() => planDiscordHistory(value)).toThrow(/Malformed/);
  });

  it("rejects an empty channel during planning before any task or receipt is created", () => {
    const value = source();
    value.channels[1].messages = [];
    expect(() => planDiscordHistory(value)).toThrow(/Empty source channel/);
    expect(existsSync(DATA_DIR)).toBe(false);
  });

  it("maps available reply IDs to stable imported IDs", () => {
    const value = source();
    (value.channels[0].messages[1] as typeof value.channels[0]["messages"][number] & { reply_to_id: string }).reply_to_id = value.channels[0].messages[0].message_id;
    const [plan] = planDiscordHistory(value);
    expect(plan.messages[1].replyToId).toBe(plan.messages[0].id);
    expect(plan.messages[1].parentId).toBe(plan.messages[0].id);
  });

  it("imports once, retries without duplicates, and preserves live active threads", () => {
    const seed = new Store(() => ({ instanceId: "claude", model: "default" }));
    botIds.forEach((_, index) => seed.createBot({ name: index ? "Opus" : "Sol" }, { seedMessages: false }));
    const file = join(DATA_DIR, "bots.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.forEach((bot: { id: string }, index: number) => { bot.id = botIds[index]; });
    const before = saved.map((bot: { threadId: string; modelSelection: unknown }) => ({ threadId: bot.threadId, model: bot.modelSelection }));
    writeFileSync(file, JSON.stringify(saved));
    const store = new Store(() => ({ instanceId: "claude", model: "default" }));
    const plans = planDiscordHistory(source());
    expect(applyDiscordHistory(store, plans).map((item) => item.replayed)).toEqual([false, false]);
    const reloaded = new Store(() => ({ instanceId: "claude", model: "default" }));
    expect(applyDiscordHistory(reloaded, plans).map((item) => item.replayed)).toEqual([true, true]);
    plans.forEach((plan, index) => {
      expect(reloaded.bot(botIds[index])?.threadId).toBe(before[index].threadId);
      expect(reloaded.bot(botIds[index])?.modelSelection).toEqual(before[index].model);
      expect(reloaded.messagesFor(plan.threadId).map((m) => m.role)).toEqual(["user", "bot"]);
      expect(reloaded.messagesFor(plan.threadId)[0].discordImport?.messageId).toBe(source().channels[index].messages[0].message_id);
    });
  });

  it("resumes after task creation and refuses a divergent existing transcript", () => {
    const seed = new Store(() => ({ instanceId: "claude", model: "default" }));
    botIds.forEach((_, index) => seed.createBot({ name: index ? "Opus" : "Sol" }, { seedMessages: false }));
    const file = join(DATA_DIR, "bots.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.forEach((bot: { id: string }, index: number) => { bot.id = botIds[index]; });
    writeFileSync(file, JSON.stringify(saved));
    const store = new Store(() => ({ instanceId: "claude", model: "default" }));
    const plans = planDiscordHistory(source());
    store.createImportedTask(plans[0].botId, plans[0].threadId, "Imported Discord #chatgpt", 1000);
    expect(applyDiscordHistory(store, plans)[0].replayed).toBe(false);
    const divergent = planDiscordHistory(source());
    divergent[0].messages[0].text = "changed";
    divergent[0].digest = "bad";
    expect(() => applyDiscordHistory(store, divergent)).toThrow(/mismatch/);
  });
});
