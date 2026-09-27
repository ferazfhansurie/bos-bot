import { useEffect, useRef, useState } from "react";
import { ListChecks } from "lucide-react";
import { api } from "@/state/store";
import { canCancelSharedRequest, sharedRequestLabels, type SharedRequestsPage } from "../../shared/shared-request";
import type { SharedContact } from "./shared-conversation";

export function SharedConversationRequests({ roomId, selfId, contacts, onShowMessage }: {
  roomId: string; selfId: string; contacts: SharedContact[];
  onShowMessage: (reference: { messageId: string; sequence: number }) => Promise<void>;
}) {
  const [page, setPage] = useState<SharedRequestsPage | null>(null);
  const [before, setBefore] = useState<number>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    let busy = false;
    setPage(null); setError("");
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api<SharedRequestsPage>(`/api/multiplayer/rooms/${roomId}/requests?limit=20${before ? `&before=${before}` : ""}`);
        if (generation.current === current) { setPage(result); setError(""); }
      } catch { if (generation.current === current) setError("Could not refresh bot requests. Check your connection and try again."); }
      finally { busy = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2000);
    return () => { generation.current++; window.clearInterval(timer); };
  }, [roomId, before, attempt]);
  const act = async (id: string, action: () => Promise<unknown>) => {
    const current = generation.current;
    setPending(id); setError("");
    try { await action(); }
    catch (cause) { if (generation.current === current) setError(cause instanceof Error ? cause.message : "Could not update this request."); }
    finally { if (generation.current === current) setPending(undefined); }
  };
  return <section aria-label="Bot requests">
    <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink"><ListChecks size={16} />Bot requests</h3>
    {!page && !error && <p role="status" className="text-xs text-ink-secondary">Loading requests…</p>}
    {page?.requests.length === 0 && <p className="text-[13px] text-ink-secondary">Mention a bot to start work together. Its progress and results will appear here.</p>}
    <div className="space-y-2">{page?.requests.map(request => <article key={request.id} className="rounded-xl border border-hairline/40 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><h4 className="text-sm font-medium text-ink">{request.botName}</h4><span className="text-xs text-ink-secondary">{sharedRequestLabels[request.state]}</span></div>
      <p className="mt-1 text-xs text-ink-secondary">{request.ownerName}’s bot · requested by {request.requesterId === selfId ? "you" : contacts.find(contact => contact.id === request.requesterId)?.name ?? "a member"}</p>
      {request.explanation && <p className="mt-2 text-xs leading-relaxed text-ink-secondary">{request.explanation}</p>}
      <div className="mt-3 flex flex-wrap gap-4 text-xs">
        <button type="button" disabled={Boolean(pending)} onClick={() => void act(request.id, () => onShowMessage({ messageId: request.sourceId, sequence: request.sourceSequence }))} className="text-accent disabled:opacity-40">Show request</button>
        {request.resultId && request.resultSequence && <button type="button" disabled={Boolean(pending)} onClick={() => void act(request.id, () => onShowMessage({ messageId: request.resultId!, sequence: request.resultSequence! }))} className="text-accent disabled:opacity-40">Show result</button>}
        {canCancelSharedRequest(request, selfId) && <button type="button" disabled={Boolean(pending)} onClick={() => void act(request.id, async () => {
          await api(`/api/multiplayer/rooms/${roomId}/requests/${request.id}/cancel`, { method: "POST" });
          setAttempt(value => value + 1); setPending(undefined);
        })} className="text-danger disabled:opacity-40">{pending === request.id ? "Stopping…" : "Stop"}</button>}
      </div>
    </article>)}</div>
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error} <button type="button" onClick={() => setAttempt(value => value + 1)} className="underline">Retry</button></p>}
    <div className="mt-3 flex gap-4 text-xs text-accent">
      {before && <button type="button" disabled={Boolean(pending)} onClick={() => setBefore(undefined)}>Recent requests</button>}
      {page?.hasMore && <button type="button" disabled={Boolean(pending)} onClick={() => setBefore(page.before)}>Earlier requests</button>}
    </div>
  </section>;
}
