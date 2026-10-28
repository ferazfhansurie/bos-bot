import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WhatsAppReplies } from "./whatsapp-replies.ts";
import { WhatsAppStore } from "./whatsapp-store.ts";
const account = "60111111111@c.us", client = "60222222222@c.us", privateChat = "60333333333@c.us";
let root: string, store: WhatsAppStore, replies: WhatsAppReplies;
let linked: string | null, send: ReturnType<typeof vi.fn<() => Promise<string>>>;
const now = 1800000000000;
const input = { account_id: account, chat_id: client, message_id: "incoming", text: "here is the booking link" };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bos-wa-replies-"));
  store = new WhatsAppStore(join(root, "messages.db"), () => now);
  linked = account; send = vi.fn(async () => "outbound-id");
  replies = new WhatsAppReplies(root, store, () => ({ accountId: () => linked, reply: send }), () => now);
  for (const [id, chatId, fromMe, timestamp] of [["incoming", client, false, now / 1000], ["private", privateChat, false, now / 1000], ["own", client, true, now / 1000], ["old", client, false, now / 1000 - 90000]] as const) store.insert({ id, chatId, fromMe, timestamp, accountId: account, chatName: "fixture", from: chatId, author: null, type: "chat", body: "hello", hasMedia: false });
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
it("refuses without owner policy and excludes personal chats from scoped reads", async () => {
  await expect(replies.reply("money", input)).rejects.toThrow("not authorized");
  replies.configure("money", { accountId: account, chatIds: [client] });
  expect(store.listChats(30, [client]).map(c => c.chatId)).toEqual([client]);
  expect(store.listMessages({ chatIds: [client], chatId: privateChat })).toEqual([]);
  expect(store.listMessages({ chatIds: [] })).toEqual([]);
  await expect(replies.reply("money", { ...input, chat_id: privateChat, message_id: "private" })).rejects.toThrow();
  expect(send).not.toHaveBeenCalled();
});
it("submits once across concurrent calls and process reconstruction", async () => {
  replies.configure("money", { accountId: account, chatIds: [client] });
  const results = await Promise.all([replies.reply("money", input), replies.reply("money", input)]);
  expect(results[0]).toMatchObject({ state: "submitted", messageId: "outbound-id" });
  expect(send).toHaveBeenCalledTimes(1);
  const restarted = new WhatsAppReplies(root, store, () => ({ accountId: () => linked, reply: send }), () => now);
  expect(await restarted.reply("money", input)).toMatchObject({ state: "submitted" });
  expect(send).toHaveBeenCalledTimes(1);
  await expect(replies.reply("money", { ...input, text: "another answer" })).rejects.toThrow("no retry");
});
it("never retries uncertain delivery, including after restart", async () => {
  replies.configure("money", { accountId: account, chatIds: [client] });
  send.mockRejectedValue(new Error("network disappeared after submission"));
  expect(await replies.reply("money", input)).toMatchObject({ state: "outcome_unknown" });
  const restarted = new WhatsAppReplies(root, store, () => ({ accountId: () => linked, reply: send }), () => now);
  expect(await restarted.reply("money", input)).toMatchObject({ state: "outcome_unknown" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("refuses changed account, sent-by-me, stale, mismatched and missing inbound messages", async () => {
  replies.configure("money", { accountId: account, chatIds: [client] });
  for (const message_id of ["own", "old", "private", "missing"]) await expect(replies.reply("money", { ...input, message_id })).rejects.toThrow();
  linked = privateChat;
  await expect(replies.reply("money", input)).rejects.toThrow("not authorized");
  linked = account; replies.configure("money", null);
  await expect(replies.reply("money", input)).rejects.toThrow("not authorized");
  expect(send).not.toHaveBeenCalled();
});
it("claims inbound dispatch once, skips old history and rejects groups", () => {
  expect(() => replies.configure("money", { accountId: account, chatIds: ["123@g.us"] })).toThrow();
  replies.configure("money", { accountId: account, chatIds: [client], autoDispatch: true });
  expect(replies.claimInbound("money", store.message("incoming")!)).toBe(true);
  expect(replies.claimInbound("money", store.message("incoming")!)).toBe(false);
  expect(replies.claimInbound("money", store.message("old")!)).toBe(false);
  expect(replies.claimInbound("money", store.message("private")!)).toBe(false);
});

it("owner-granted shared access allows callable replies without waking on every personal chat", async () => {
  replies.configure("money", { accountId: account, chatIds: null });
  expect(replies.claimInbound("money", store.message("incoming")!)).toBe(false);
  expect(await replies.reply("money", input)).toMatchObject({ state: "submitted" });
  expect(() => replies.configure("money", { accountId: account, chatIds: null, autoDispatch: true })).toThrow();
});

it("revocation preserves read isolation and unknown or different-account history fails closed", async () => {
  replies.configure("money", { accountId: account, chatIds: [client] });
  const source = store.message("incoming")!;
  store.insert({ ...source, id: "unknown-account", accountId: null });
  store.insert({ ...source, id: "wrong-account", accountId: privateChat });
  expect(store.listMessages({ chatIds: [client], accountId: account }).some(m => m.id === "unknown-account" || m.id === "wrong-account")).toBe(false);
  expect(store.listChats(30, undefined, account).find(c => c.chatId === client)?.messageCount).toBe(3);
  for (const message_id of ["unknown-account", "wrong-account"]) await expect(replies.reply("money", { ...input, message_id })).rejects.toThrow();
  replies.configure("money", null);
  expect(replies.policy("money")?.chatIds).toEqual([]);
  expect(store.listMessages({ chatIds: replies.policy("money")!.chatIds ?? [], accountId: account })).toEqual([]);
  expect(send).not.toHaveBeenCalled();
});
it("outreach sends to named chats without an incoming message, once per send_key", async () => {
  const msg = { account_id: account, chat_id: client, send_key: "lead-day3", text: "following up on your ad plan" };
  replies.configure("money", { accountId: account, chatIds: [client], autoDispatch: true });
  await expect(replies.send("money", msg)).rejects.toThrow("not granted");
  expect(() => replies.configure("money", { accountId: account, chatIds: null, outreach: true } as never)).toThrow("named chat list");
  replies.configure("money", { accountId: account, chatIds: [client], autoDispatch: true, outreach: true } as never);
  expect(await replies.send("money", msg)).toMatchObject({ state: "submitted", messageId: "outbound-id" });
  expect(send).toHaveBeenLastCalledWith({ account_id: account, chat_id: client, message_id: "", text: msg.text }, expect.any(Function));
  expect(await replies.send("money", msg)).toMatchObject({ state: "submitted" });
  await expect(replies.send("money", { ...msg, text: "different" })).rejects.toThrow("no retry");
  await expect(replies.send("money", { ...msg, chat_id: privateChat, send_key: "x" })).rejects.toThrow("not granted");
  expect(send).toHaveBeenCalledTimes(1);
});
it("replies and sends to privacy-id (@lid) chats in scope, never to unlisted ones", async () => {
  const lead = "96396397047822@lid", stranger = "11111111111111@lid";
  for (const [id, chatId] of [["lid-in", lead], ["lid-out", stranger]] as const) store.insert({ id, chatId, fromMe: false, timestamp: now / 1000, accountId: account, chatName: "fixture", from: chatId, author: null, type: "chat", body: "Hi Money", hasMedia: false });
  replies.configure("money", { accountId: account, chatIds: [lead], autoDispatch: true, outreach: true } as never);
  expect(replies.eligible("money", store.listMessages({ chatId: lead })[0]!)).toBe(true);
  expect(await replies.reply("money", { account_id: account, chat_id: lead, message_id: "lid-in", text: "hi" })).toMatchObject({ state: "submitted" });
  expect(await replies.send("money", { account_id: account, chat_id: lead, send_key: "lid-day1", text: "follow up" })).toMatchObject({ state: "submitted" });
  await expect(replies.reply("money", { account_id: account, chat_id: stranger, message_id: "lid-out", text: "hi" })).rejects.toThrow();
  await expect(replies.send("money", { account_id: account, chat_id: stranger, send_key: "x", text: "hi" })).rejects.toThrow();
  expect(send).toHaveBeenCalledTimes(2);
});
it("read-all reads every chat on the account while sending stays limited to the named list", async () => {
  replies.configure("money", { accountId: account, chatIds: [], readAll: true } as never);
  expect(replies.readScope("money")).toBeUndefined();
  expect(replies.canSend("money")).toBe(false);
  expect(store.listChats(30, replies.readScope("money"), account).map(c => c.chatId).sort()).toEqual([client, privateChat].sort());
  await expect(replies.reply("money", input)).rejects.toThrow("not authorized");
  replies.configure("money", { accountId: account, chatIds: [client], readAll: true } as never);
  expect(replies.readScope("money")).toBeUndefined();
  await expect(replies.reply("money", { ...input, chat_id: privateChat, message_id: "private" })).rejects.toThrow("not authorized");
  replies.configure("money", null);
  expect(replies.readScope("money")).toEqual([]);
  expect(() => replies.configure("money", { accountId: account, chatIds: [], readAll: "yes" } as never)).toThrow();
  expect(send).not.toHaveBeenCalled();
});
it("read-only reads the named chats and can never send, even if a grant asks", async () => {
  replies.configure("money", { accountId: account, chatIds: [client], readOnly: true } as never);
  expect(replies.readScope("money")).toEqual([client]);
  expect(replies.canSend("money")).toBe(false);
  expect(replies.eligible("money", store.listMessages({ chatId: client }).find(m => m.id === "incoming")!)).toBe(false);
  await expect(replies.reply("money", input)).rejects.toThrow();
  await expect(replies.send("money", { account_id: account, chat_id: client, send_key: "ro", text: "hi" })).rejects.toThrow();
  for (const bad of [{ autoDispatch: true }, { outreach: true }, { readOnly: "yes" }]) expect(() => replies.configure("money", { accountId: account, chatIds: [client], readOnly: true, ...bad } as never)).toThrow();
  expect(send).not.toHaveBeenCalled();
});
it("names unnamed chats once, per account, without overwriting a real name", () => {
  store.insert({ id: "nameless", chatId: "219920001234567@lid", fromMe: false, timestamp: now / 1000, accountId: account, chatName: null, from: "219920001234567@lid", author: null, type: "chat", body: "hi", hasMedia: false });
  store.insert({ id: "other-acct", chatId: "219920001234567@lid", fromMe: false, timestamp: now / 1000, accountId: "60999999999@c.us", chatName: null, from: "219920001234567@lid", author: null, type: "chat", body: "hi", hasMedia: false });
  expect(store.listChats(30, undefined, account).find(c => c.chatId === "219920001234567@lid")?.chatName).toBeNull();
  expect(store.nameChats(account, { "219920001234567@lid": "Aina", [client]: "overwrite" })).toBe(1);
  expect(store.listChats(30, undefined, account).find(c => c.chatId === "219920001234567@lid")?.chatName).toBe("Aina");
  expect(store.listChats(30, undefined, account).find(c => c.chatId === client)?.chatName).toBe("fixture");
  expect(store.listChats(30, undefined, "60999999999@c.us").find(c => c.chatId === "219920001234567@lid")?.chatName).toBeNull();
});
it("an owner takeover pauses replies, outreach and auto-dispatch until hand back", async () => {
  replies.configure("money", { accountId: account, chatIds: [client], autoDispatch: true, outreach: true });
  replies.hold(true);
  expect(replies.held()).toBe(true);
  await expect(replies.reply("money", input)).rejects.toThrow("taken over");
  await expect(replies.send("money", { account_id: account, chat_id: client, send_key: "k1", text: "hi" })).rejects.toThrow("taken over");
  expect(replies.claimInbound("money", store.message("incoming")!)).toBe(false);
  expect(send).not.toHaveBeenCalled();
  replies.hold(false);
  // a refused reply used no attempt, so it can go once the owner hands back
  expect(await replies.reply("money", input)).toMatchObject({ state: "submitted" });
  expect(send).toHaveBeenCalledTimes(1);
});
it("a takeover mid-send revokes the transport's authorization", async () => {
  replies.configure("money", { accountId: account, chatIds: [client] });
  let checked: boolean | undefined;
  send.mockImplementation(async (...args: unknown[]) => { replies.hold(true); checked = (args[1] as () => boolean)(); return checked ? "outbound-id" : ""; });
  expect(await replies.reply("money", input)).toMatchObject({ state: "outcome_unknown" });
  expect(checked).toBe(false);
});
it("keeps draft mode until the owner turns it off explicitly", () => {
  expect(() => replies.configure("bos", { accountId: account, chatIds: [client], autoDispatch: true, draft: "yes" })).toThrow();
  replies.configure("bos", { accountId: account, chatIds: [client], autoDispatch: true, draft: true });
  expect(replies.policy("bos")).toMatchObject({ autoDispatch: true, draft: true });
  expect(replies.drafts("bos")).toBe(true);
  expect(replies.claimInbound("bos", store.message("incoming")!)).toBe(true);
  replies.configure("bos", { accountId: account, chatIds: [client], autoDispatch: true });
  expect(replies.drafts("bos")).toBe(true);
  replies.configure("bos", { accountId: account, chatIds: [client], autoDispatch: true, draft: false });
  expect(replies.drafts("bos")).toBe(false);
  expect(replies.policy("bos")).not.toHaveProperty("draft");
});
