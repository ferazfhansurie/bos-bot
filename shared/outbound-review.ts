export interface OutboundContent {
  channel: string;
  recipient: string;
  account?: string;
  subject?: string;
  body: string;
}
export interface OutboundReview extends OutboundContent {
  status: "pending" | "approved" | "discarded" | "submitted";
  approvedAt?: number;
  receipt?: { toolMessageId: string; id: string; at: number };
}
export function outboundApprovalText(requestId: string, content: OutboundContent): string {
  return `i approve outbound draft ${requestId} for this exact channel, recipient, account, subject and body only. use your existing connected tools and their normal permission rules to send it once. do not change, expand or add recipients or content. if unavailable, blocked, failed or outcome_unknown, report that honestly; never retry an uncertain send. after an actual tool receipt, call record_outbound_receipt with this request id and provider receipt id; the server must match the actual successful send tool result in this approved turn. include tool_message_id only if known. approval is not proof of sending.\n\n${JSON.stringify({ channel: content.channel, recipient: content.recipient, account: content.account ?? "", subject: content.subject ?? "", body: content.body }, null, 2)}`;
}
