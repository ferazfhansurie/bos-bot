import { afterEach, describe, expect, it } from "vitest";
import * as db from "./message-db.ts";
import { queueSteeredMessage, editSteeredMessage, queuedSteerSnapshot, restoreSteeredMessages, holdSteeredQueue, cancelSteeredMessage } from "./steer-queue.ts";
import { queueChannelMessage, editChannelMessage, queuedChannelSnapshot, restoreChannelMessages, drainChannelMessages } from "./channel-queue.ts";
afterEach(() => { db.settleChatFollowups(db.chatFollowups().map(r => r.id), null); restoreSteeredMessages(); restoreChannelMessages(); });
describe("queued text compare and edit", () => {
  it("retains identity, order, files and reply context durably, with retry", () => {
    const tag = '<attached-file path="/fixture/doc.pdf" name="doc.pdf" />';
    const before = `old\n\n${tag}`, after = `new\n\n${tag}`;
    const q = queueSteeredMessage("bot", "thread", before, { sendId: "send", replyToId: "reply", prompt: `context\n${before}`, reason: "capacity" });
    const second = queueSteeredMessage("bot", "thread", "second");
    expect(editSteeredMessage("bot", "thread", q.id, before, after, () => `context\n${after}`)).toBe(true);
    expect(editSteeredMessage("bot", "thread", q.id, before, after)).toBe(true);
    db.closeMessageDb(); restoreSteeredMessages();
    expect(queuedSteerSnapshot(() => true).thread).toEqual([{ queueId: q.id, text: after, reason: "capacity" }, { queueId: second.id, text: "second" }]);
    expect(db.chatFollowups()[0].payload).toMatchObject({ text: after, prompt: `context\n${after}`, sendId: "send", replyToId: "reply" });
  });
  it("refuses owner, thread, stale, held, cancelled and unknown without replacing", () => {
    const q = queueSteeredMessage("bot", "thread", "old");
    for (const [owner, thread, id, expected] of [["other","thread",q.id,"old"], ["bot","other",q.id,"old"], ["bot","thread",q.id,"stale"], ["bot","thread","missing","old"]]) expect(editSteeredMessage(owner,thread,id,expected,"new")).toBe(false);
    expect(queuedSteerSnapshot(() => true).thread[0].text).toBe("old");
    holdSteeredQueue("bot", "thread", q.id);
    expect(editSteeredMessage("bot","thread",q.id,"old","new")).toBe(false);
    const cancelled = queueSteeredMessage("bot", "thread", "cancel"); cancelSteeredMessage("bot",cancelled.id);
    expect(editSteeredMessage("bot","thread",cancelled.id,"cancel","new")).toBe(false);
  });
  it("checks durable pending state even when the memory entry still exists", () => {
    const q = queueSteeredMessage("bot","thread","old");
    db.settleChatFollowups([q.id], "dispatching");
    expect(editSteeredMessage("bot","thread",q.id,"old","new")).toBe(false);
    expect(queuedSteerSnapshot(() => true).thread[0].text).toBe("old");
    expect(db.chatFollowups()[0].status).toBe("dispatching");
  });
  it("rejects changed attachment tags and unattended work", () => {
    const text = 'old <attached-image path="/fixture/a.png" />';
    const q = queueSteeredMessage("bot","thread",text);
    expect(() => editSteeredMessage("bot","thread",q.id,text,"new")).toThrow(/attachments/);
    const peer = queueSteeredMessage("bot","thread","peer",{unattended:true});
    expect(editSteeredMessage("bot","thread",peer.id,"peer","new")).toBe(false);
  });
  it("edits only the pinned channel and conflicts after drain", () => {
    const q = queueChannelMessage("room","thread","old",{sendId:"send",mode:"goal",sender:{name:"owner"}});
    expect(editChannelMessage("room","wrong",q.id,"old","new")).toBe(false);
    expect(editChannelMessage("wrong","thread",q.id,"old","new")).toBe(false);
    expect(editChannelMessage("room","thread",q.id,"old","new")).toBe(true);
    restoreChannelMessages(); expect(queuedChannelSnapshot(() => true).thread[0]).toEqual({queueId:q.id,text:"new"});
    const delivered: any[] = []; drainChannelMessages(() => false, input => { delivered.push(input); });
    expect(delivered[0]).toMatchObject({id:q.id,text:"new",sendId:"send",mode:"goal",sender:{name:"owner"}});
    expect(editChannelMessage("room","thread",q.id,"old","new")).toBe(false);
  });
});
