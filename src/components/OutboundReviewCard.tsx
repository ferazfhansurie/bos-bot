import { useRef, useState } from "react";
import { api, currentTaskBot, useStore, type Message } from "@/state/store";
import type { OutboundReview } from "../../shared/outbound-review";

export function OutboundReviewCard({ botId, threadId, message }: { botId: string; threadId: string; message: Message }) {
  const { state, dispatch } = useStore();
  const draft = message.card?.outboundReview;
  const requestId = message.card?.requestId;
  const [localStatus, setLocalStatus] = useState<OutboundReview["status"]>(draft?.status ?? "pending");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const guard = useRef(false);
  if (!draft || !requestId) return null;
  const status = draft.status === "pending" ? localStatus : draft.status;
  const bot = state.bots.find(candidate => candidate.id === botId);
  const task = bot ? currentTaskBot(bot, threadId) : undefined;
  const approvalInThread = task?.messages.some(m => m.role === "user" && m.sendId === `outbound-${requestId}`);
  const decide = async (decision: "approve" | "discard") => {
    if (guard.current) return;
    guard.current = true; setPending(true); setError("");
    try {
      const result = await api<{ status: OutboundReview["status"]; text?: string; sendId?: string }>(`/api/threads/${encodeURIComponent(threadId)}/outbound-reviews/${encodeURIComponent(requestId)}`, { method: "POST", body: JSON.stringify({ decision }) });
      setLocalStatus(result.status);
      if (result.status === "approved" && result.text && result.sendId) dispatch({ type: "send", botId, threadId, sendId: result.sendId, text: result.text });
    } catch (e) { setError(e instanceof Error ? e.message : "could not save decision"); }
    finally { guard.current = false; setPending(false); }
  };
  return <section aria-label="outbound message review" className="w-full max-w-[42rem] rounded-2xl border border-hairline bg-card p-4 text-sm">
    <div className="mb-3 font-semibold">review before sending</div>
    <dl className="mb-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt className="text-ink-secondary">channel</dt><dd className="break-words">{draft.channel}</dd>
      <dt className="text-ink-secondary">to</dt><dd className="break-words whitespace-pre-wrap">{draft.recipient}</dd>
      <dt className="text-ink-secondary">from account</dt><dd className="break-words">{draft.account || "configured account"}</dd>
      {draft.subject !== undefined && <><dt className="text-ink-secondary">subject</dt><dd className="break-words whitespace-pre-wrap">{draft.subject || "(empty)"}</dd></>}
    </dl>
    <div aria-label="exact message body" className="max-h-96 overflow-auto rounded-lg border border-hairline bg-inset p-3 whitespace-pre-wrap break-words">{draft.body}</div>
    <p role="status" className="my-3 text-xs text-ink-secondary">{status === "pending" ? "nothing sent. approve only if the recipient and full message are correct." : status === "discarded" ? "discarded. this draft was not authorized." : status === "submitted" ? "tool reported submission. recipient delivery is not confirmed." : "approved. waiting for a successful send tool receipt; approval alone does not mean sent."}</p>
    {status === "submitted" && draft.receipt && <p className="mb-3 break-all text-xs text-ink-secondary">receipt: {draft.receipt.id} · tool message: {draft.receipt.toolMessageId}</p>}
    {error && <p role="alert" className="mb-3 text-xs text-danger">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {status === "pending" && <><button type="button" disabled={pending || task?.busy} onClick={() => void decide("approve")} className="rounded-lg bg-accent px-3 py-2 text-accent-ink disabled:opacity-40">{pending ? "saving…" : "approve exact message"}</button><button type="button" disabled={pending} onClick={() => void decide("discard")} className="rounded-lg border border-hairline px-3 py-2 disabled:opacity-40">discard</button></>}
      {status === "approved" && !approvalInThread && <button type="button" disabled={pending || task?.busy} onClick={() => void decide("approve")} className="rounded-lg border border-hairline px-3 py-2 disabled:opacity-40">continue approved request in this thread</button>}
    </div>
  </section>;
}
