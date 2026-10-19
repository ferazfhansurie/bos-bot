import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { WireMessage, OptionCardData } from "../shared/wire.ts";
import { outboundApprovalText, type OutboundReview } from "../shared/outbound-review.ts";

export const outboundContentSchema = z.object({
  channel: z.string().trim().min(1).max(100), recipient: z.string().trim().min(1).max(500),
  account: z.string().trim().min(1).max(300), subject: z.string().max(1000).optional(), body: z.string().min(1).max(20_000),
}).strict();
export interface OutboundReviewStore {
  messagesFor(threadId: string): WireMessage[];
  appendMessage(threadId: string, message: Omit<WireMessage, "id" | "at">): WireMessage;
  patchMessage(threadId: string, id: string, patch: Partial<WireMessage>): WireMessage | null;
}
const refusal = (message: string) => Object.assign(new Error(message), { status: 409 });
export class OutboundReviews {
  private store: OutboundReviewStore;
  private now: () => number;
  constructor(store: OutboundReviewStore, now: () => number = Date.now) { this.store = store; this.now = now; }
  propose(threadId: string, content: unknown) {
    const parsed = outboundContentSchema.parse(content);
    const requestId = randomUUID();
    const message = this.store.appendMessage(threadId, { role: "bot", kind: "options", card: {
      title: "review before sending", subtitle: `channel: ${parsed.channel}\nto: ${parsed.recipient}\nfrom: ${parsed.account || "configured account"}${parsed.subject !== undefined ? `\nsubject: ${parsed.subject}` : ""}\n\n${parsed.body}\n\nopen the desktop or web review card to approve or discard. nothing has been sent.`, options: [], requestId,
      outboundReview: { ...parsed, status: "pending" },
    } });
    return { state: "pending", requestId, messageId: message.id, note: "nothing sent; wait for the person's explicit approval in this thread" };
  }
  private find(threadId: string, requestId: string) {
    const message = this.store.messagesFor(threadId).find(m => m.card?.requestId === requestId && m.card.outboundReview);
    if (!message?.card?.outboundReview) throw refusal("outbound draft no longer available in this thread");
    return message as WireMessage & { card: OptionCardData & { outboundReview: OutboundReview } };
  }
  decide(threadId: string, requestId: string, decision: "approve" | "discard") {
    const message = this.find(threadId, requestId);
    const draft = message.card.outboundReview;
    if (draft.status === "discarded" || draft.status === "submitted" || (draft.status === "approved" && decision === "discard")) throw refusal("this draft has already been settled");
    const next: OutboundReview = decision === "approve" ? { ...draft, status: "approved", approvedAt: draft.approvedAt ?? this.now() } : { ...draft, status: "discarded" };
    this.store.patchMessage(threadId, message.id, { card: { ...message.card, outboundReview: next, answered: decision === "approve" ? "approved exact message" : "discarded" } });
    return { messageId: message.id, status: next.status, ...(decision === "approve" ? { sendId: `outbound-${requestId}`, text: outboundApprovalText(requestId, draft) } : {}) };
  }
  record(threadId: string, requestId: string, toolMessageId: string | undefined, receiptId: string) {
    const message = this.find(threadId, requestId);
    const draft = message.card.outboundReview;
    if (draft.status === "submitted" && draft.receipt?.id === receiptId && (!toolMessageId || draft.receipt.toolMessageId === toolMessageId)) return { state: "submitted", receipt: draft.receipt };
    if (draft.status !== "approved" || !draft.approvedAt) throw refusal("this draft has no pending approved send");
    const messages = this.store.messagesFor(threadId);
    const approval = messages.find(m => m.role === "user" && m.sendId === `outbound-${requestId}` && m.text === outboundApprovalText(requestId, draft));
    const byId = new Map(messages.map(m => [m.id, m]));
    const inApprovedTurn = (source: WireMessage) => {
      if (!approval) return false;
      const seen = new Set<string>();
      let ancestor: WireMessage | undefined = source;
      while (ancestor && !seen.has(ancestor.id)) {
        if (ancestor.role === "user") return ancestor.id === approval.id;
        seen.add(ancestor.id);
        ancestor = ancestor.parentId ? byId.get(ancestor.parentId) : undefined;
      }
      return false;
    };
    const candidates = messages.filter(source => {
      if ((toolMessageId && source.id !== toolMessageId) || source.role !== "bot" || source.kind !== "activity" || source.tool?.ok !== true || !source.tool.input || !source.tool.output || !inApprovedTurn(source)) return false;
      try { verifyOutboundToolReceipt(draft, source.tool.name, source.tool.input, source.tool.output, receiptId); return true; } catch { return false; }
    });
    if (candidates.length !== 1) throw refusal("one successful send tool result in the exact approved turn is required");
    const receipt = { toolMessageId: candidates[0].id, id: receiptId, at: this.now() };
    this.store.patchMessage(threadId, message.id, { card: { ...message.card, outboundReview: { ...draft, status: "submitted", receipt } } });
    return { state: "submitted", receipt, note: "tool reported submission; this is not recipient delivery" };
  }

}

/** Fail closed when a provider's preview cannot prove the exact send and id. */
export function verifyOutboundToolReceipt(draft: OutboundReview, name: string, input: string, output: string, receiptId: string): void {
  if (!receiptId.trim() || receiptId.length > 300 || !draft.account) throw refusal("a provider receipt id and exact sending account are required");
  let sent: unknown, result: unknown;
  try { sent = JSON.parse(input); result = JSON.parse(output); } catch { throw refusal("this tool's preview does not expose a structured receipt; keep the draft awaiting receipt"); }
  const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
  const canonical = (value: string) => value.split("__").at(-1)!.toUpperCase();
  let tool = canonical(name), args = object(sent), connection: unknown;
  if (tool === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    if (!args || !only(args, ["tools", "sync_response_to_workbench"]) || !Array.isArray(args.tools) || args.tools.length !== 1) throw refusal("only one explicit send call can prove this receipt");
    const call = object(args.tools[0]);
    if (!call || !only(call, ["tool_slug", "arguments", "connected_account_id"]) || typeof call.tool_slug !== "string") throw refusal("unsupported send call schema");
    tool = canonical(call.tool_slug); connection = call.connected_account_id; args = object(call.arguments);
    // A batch receipt must identify the exact sole tool. Do not search other
    // read results, metadata or historical IDs anywhere in the wrapper.
    const wrapper = object(result);
    const data = object(wrapper?.data);
    const results = wrapper?.results ?? data?.results;
    if (!wrapper || wrapper.successful !== true || !Array.isArray(results) || results.length !== 1) throw refusal("a successful result for the exact single send call is required");
    const entry = object(results[0]);
    if (!entry || entry.tool_slug !== tool || entry.successful !== true) throw refusal("receipt result does not identify the successful send tool");
    result = entry;
  }
  if (!args) throw refusal("unsupported send input schema");
  const receipt = object(result);
  if (tool === "BOS_WHATSAPP_SEND" || tool === "BOS_WHATSAPP_REPLY") {
    const keys = tool === "BOS_WHATSAPP_SEND" ? ["account_id", "chat_id", "send_key", "text"] : ["account_id", "chat_id", "message_id", "text"];
    if (draft.channel.toLowerCase() !== "whatsapp" || !only(args, keys) || args.account_id !== draft.account || args.chat_id !== draft.recipient || args.text !== draft.body || (draft.subject !== undefined && draft.subject !== "") || typeof args[tool === "BOS_WHATSAPP_SEND" ? "send_key" : "message_id"] !== "string") throw refusal("native send fields do not match the exact approved message");
    if (!receipt || receipt.state !== "submitted" || receipt.messageId !== receiptId || receipt.error || receipt.success === false || receipt.successful === false || receipt.ok === false) throw refusal("native provider submission receipt not found");
    return;
  }
  if (tool === "GMAIL_SEND_EMAIL") {
    const emptyRecipients = (value: unknown) => value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
    const account = args.connected_account_id ?? connection;
    if (!["gmail", "email"].includes(draft.channel.toLowerCase()) || !only(args, ["recipient_email", "subject", "body", "connected_account_id", "user_id", "is_html", "cc", "bcc"]) || args.recipient_email !== draft.recipient || args.body !== draft.body || args.subject !== (draft.subject ?? "") || account !== draft.account || (connection !== undefined && connection !== account) || !emptyRecipients(args.cc) || !emptyRecipients(args.bcc) || (args.is_html !== undefined && args.is_html !== false) || (args.user_id !== undefined && args.user_id !== "me")) throw refusal("gmail fields do not match the exact approved recipient, account, subject and body");
    const data = object(receipt?.data);
    if (!receipt || receipt.successful !== true || !data || data.id !== receiptId || typeof data.threadId !== "string" || receipt.error || data.error) throw refusal("successful gmail message receipt not found");
    return;
  }
  throw refusal("this provider schema has no trusted receipt adapter; keep the draft awaiting receipt");
}
