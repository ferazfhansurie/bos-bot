import { describe, expect, it } from "vitest";
import type { WireMessage } from "../shared/wire.ts";
import { outboundApprovalText, type OutboundReview } from "../shared/outbound-review.ts";
import { OutboundReviews, verifyOutboundToolReceipt } from "./outbound-reviews.ts";

const content = { channel: "email", recipient: "owner@example.test", account: "sender@example.test", subject: "the proposal", body: "hello\n\nexact approved body" };
const approved: OutboundReview = { ...content, status: "approved", approvedAt: 100 };
function setup() {
  const threads = new Map<string, WireMessage[]>();
  const store = {
    messagesFor: (id: string) => threads.get(id) ?? [],
    appendMessage: (id: string, source: Omit<WireMessage, "id" | "at">) => { const m = { ...source, id: crypto.randomUUID(), at: 110, parentId: (threads.get(id) ?? []).at(-1)?.id ?? null }; threads.set(id, [...(threads.get(id) ?? []), m]); return m; },
    patchMessage: (id: string, mid: string, patch: Partial<WireMessage>) => { const list = threads.get(id) ?? []; const i = list.findIndex(m => m.id === mid); if (i < 0) return null; list[i] = { ...list[i], ...patch }; return list[i]; },
  };
  return { store, service: new OutboundReviews(store, () => 100), threads };
}
const arguments_ = { recipient_email: content.recipient, body: content.body, subject: content.subject, connected_account_id: content.account };
const input = JSON.stringify({ tools: [{ tool_slug: "GMAIL_SEND_EMAIL", arguments: arguments_ }] });
const output = JSON.stringify({ successful: true, results: [{ tool_slug: "GMAIL_SEND_EMAIL", successful: true, data: { id: "provider-message-1", threadId: "provider-thread" } }] });
describe("exact outbound review", () => {
  it("persists a pending review without any execution, and pins approval to exact content", () => {
    const { store, service } = setup();
    const p = service.propose("one", content);
    expect(store.messagesFor("one")[0].card?.outboundReview?.status).toBe("pending");
    const result = service.decide("one", p.requestId, "approve");
    expect(result.text).toBe(outboundApprovalText(p.requestId, approved));
    expect(result.sendId).toBe(`outbound-${p.requestId}`);
    expect(service.decide("one", p.requestId, "approve")).toEqual(result);
    expect(() => service.decide("other", p.requestId, "approve")).toThrow("this thread");
    expect(store.messagesFor("one")).toHaveLength(1);
  });
  it("never upgrades discard or approval to sent without actual successful tool evidence", () => {
    const { store, service } = setup();
    const p = service.propose("one", content);
    service.decide("one", p.requestId, "discard");
    expect(() => service.decide("one", p.requestId, "approve")).toThrow("settled");
    expect(() => service.record("one", p.requestId, "claim", "provider-message-1")).toThrow("no pending approved send");
    const q = service.propose("one", content);
    service.decide("one", q.requestId, "approve");
    expect(() => service.record("one", q.requestId, "claim", "provider-message-1")).toThrow("tool result");
    store.appendMessage("one", { role: "user", kind: "text", sendId: `outbound-${q.requestId}`, text: outboundApprovalText(q.requestId, content) });
    const tool = store.appendMessage("one", { role: "bot", kind: "activity", tool: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", input, output, ok: true } });
    expect(service.record("one", q.requestId, tool.id, "provider-message-1").state).toBe("submitted");
    expect(store.messagesFor("one").find(m => m.card?.requestId === q.requestId)?.card?.outboundReview?.receipt?.id).toBe("provider-message-1");
  });
  it("rejects changed recipients/bodies/accounts, cross-channel and multi-send batches", () => {
    for (const wrong of [input.replace(content.recipient, "other@example.test"), input.replace(content.account, "other@example.test"), input.replace("GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"), input.replace("exact approved body", "edited body"), JSON.stringify({ tools: [JSON.parse(input).tools[0], JSON.parse(input).tools[0]] })]) {
      expect(() => verifyOutboundToolReceipt(approved, "COMPOSIO_MULTI_EXECUTE_TOOL", wrong, output, "provider-message-1")).toThrow();
    }
  });
  it("refuses prose, unknown/failure and unrelated opaque IDs", () => {
    for (const bad of ["sent successfully", JSON.stringify({ successful: false, data: { message_id: "x" } }), JSON.stringify({ state: "outcome_unknown", messageId: "x" }), JSON.stringify({ successful: true, data: { id: "x" } }), JSON.stringify({ successful: true, data: { account_id: "x" } })]) {
      expect(() => verifyOutboundToolReceipt(approved, "COMPOSIO_MULTI_EXECUTE_TOOL", input, bad, "x")).toThrow();
    }
  });
  it("rejects approved strings smuggled in metadata, extra recipients and changed empty subjects", () => {
    const directOutput = JSON.stringify({ successful: true, data: { id: "p", threadId: "t" } });
    for (const args of [
      { ...arguments_, recipient_email: "wrong@example.test", metadata: { recipient: content.recipient } },
      { ...arguments_, body: "wrong", metadata: { body: content.body } },
      { ...arguments_, cc: ["extra@example.test"] }, { ...arguments_, bcc: "extra@example.test" },
      { ...arguments_, subject: "unexpected subject" },
    ]) expect(() => verifyOutboundToolReceipt({ ...approved, subject: "" }, "GMAIL_SEND_EMAIL", JSON.stringify(args), directOutput, "p")).toThrow();
    expect(() => verifyOutboundToolReceipt({ ...approved, subject: "" }, "GMAIL_SEND_EMAIL", JSON.stringify({ ...arguments_, subject: "" }), directOutput, "p")).not.toThrow();
  });
  it("refuses a read result's old id and an unrelated later turn", () => {
    const mixed = JSON.stringify({ successful: true, results: [{ tool_slug: "GMAIL_SEND_EMAIL", successful: false }, { tool_slug: "GMAIL_GET_MESSAGE", successful: true, data: { id: "old", threadId: "old" } }] });
    expect(() => verifyOutboundToolReceipt(approved, "COMPOSIO_MULTI_EXECUTE_TOOL", input, mixed, "old")).toThrow();
    const { store, service } = setup(); const p = service.propose("t", content); service.decide("t", p.requestId, "approve");
    store.appendMessage("t", { role: "user", kind: "text", sendId: `outbound-${p.requestId}`, text: outboundApprovalText(p.requestId, content) });
    store.appendMessage("t", { role: "user", kind: "text", text: "a later unrelated task" });
    const tool = store.appendMessage("t", { role: "bot", kind: "activity", tool: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", input, output, ok: true } });
    expect(() => service.record("t", p.requestId, tool.id, "provider-message-1")).toThrow("exact approved turn");
  });
  it("accepts a structured native send receipt without claiming recipient delivery", () => {
    expect(() => verifyOutboundToolReceipt({ channel: "whatsapp", account: "self@c.us", recipient: "1@c.us", body: "hello", status: "approved" }, "BOS_WHATSAPP_SEND", JSON.stringify({ account_id: "self@c.us", chat_id: "1@c.us", text: "hello", send_key: "fixture" }), JSON.stringify({ state: "submitted", messageId: "m1" }), "m1")).not.toThrow();
  });
});
