import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api } from "@/state/store";
import type { SharedSearchKind } from "../../shared/shared-search-kinds";
import type { SharedContact, SharedMessage, SharedEligibleBot } from "./shared-conversation";

const filters: Array<[SharedSearchKind, string]> = [["all", "All messages"], ["people", "People"], ["bots", "Bots"], ["files", "Files"], ["links", "Links"], ["results", "Bot results"]];
interface SearchPage { messages: SharedMessage[]; hasMore: boolean; before: number | null }

export function SharedConversationSearch({ roomId, selfId, contacts, onShowMessage, focusToken = 0, bots = [] }: {
  bots?: SharedEligibleBot[];
  focusToken?: number;
  roomId: string; selfId: string; contacts: SharedContact[];
  onShowMessage: (message: { messageId: string; sequence: number }) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SharedSearchKind>("all");
  const [author, setAuthor] = useState("");
  const [page, setPage] = useState<SearchPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const people = contacts.filter(contact => contact.kind === "person");
  const authors = [...people, ...bots.map(bot => ({ id: bot.id, name: `${bot.name} · ${bot.ownerName}` }))];
  const generation = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusToken) { inputRef.current?.scrollIntoView({ block: "nearest" }); inputRef.current?.focus(); } }, [focusToken]);
  const load = async (before?: number) => {
    const token = ++generation.current;
    setLoading(true); setError("");
    if (!before) setPage(null);
    const params = new URLSearchParams({ q: query, kind, author, limit: "20" });
    if (before) params.set("before", String(before));
    try {
      const next = await api<SearchPage>(`/api/multiplayer/rooms/${roomId}/search?${params}`);
      if (generation.current === token) setPage(previous => ({ ...next, messages: before && previous ? [...previous.messages, ...next.messages.filter(message => !previous.messages.some(old => old.id === message.id))] : next.messages }));
    } catch { if (generation.current === token) setError("Could not search this conversation. Check the connection and try again."); }
    finally { if (generation.current === token) setLoading(false); }
  };
  useEffect(() => {
    generation.current += 1; setPage(null); setError(""); setLoading(true);
    const timer = setTimeout(() => void load(), 250);
    return () => { clearTimeout(timer); generation.current += 1; };
  }, [roomId, query, kind, author]);
  const show = async (message: SharedMessage) => {
    setOpening(message.id); setError("");
    try { await onShowMessage({ messageId: message.id, sequence: message.sequence }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this message."); }
    finally { setOpening(null); }
  };
  return <section aria-label="Search conversation">
    <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink"><Search size={16} />Search conversation</h3>
    <input ref={inputRef} aria-label="Search conversation history" placeholder="Search messages and file names…" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} className="w-full rounded-lg bg-control px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent" />
    <div className="my-2 flex gap-2">
      <select aria-label="Message type" value={kind} onChange={event => setKind(event.target.value as SharedSearchKind)} className="min-w-0 flex-1 rounded-lg bg-control px-2 py-2 text-xs text-ink">{filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <select aria-label="Message author" value={author} onChange={event => setAuthor(event.target.value)} className="min-w-0 flex-1 rounded-lg bg-control px-2 py-2 text-xs text-ink"><option value="">Anyone</option>{authors.map(contact => <option key={contact.id} value={contact.id}>{contact.id === selfId ? "You" : contact.name}</option>)}</select>
    </div>
    {page && !page.messages.length && <p className="py-3 text-xs text-ink-secondary">No matching messages. Try another word or filter.</p>}
    <div className="max-h-80 space-y-2 overflow-y-auto">{page?.messages.map(message => {
      const actorId = `${message.actor.homeId}:${message.actor.kind}:${message.actor.localId}`;
      const name = actorId === selfId ? "You" : authors.find(contact => contact.id === actorId)?.name ?? (message.actor.kind === "bot" ? "Bot" : "Member");
      return <button type="button" key={message.id} disabled={opening !== null} onClick={() => void show(message)} className="block w-full rounded-lg border border-hairline/40 p-3 text-left hover:bg-control disabled:opacity-50" aria-label={`Show message from ${name}: ${(message.text || message.attachments?.map(file => file.name).join(", ") || "Shared file").slice(0, 160)}`}>
        <div className="mb-1 flex justify-between gap-2 text-xs text-ink-secondary"><span className="truncate">{name}</span><span className="shrink-0">{new Date(message.at).toLocaleDateString()}</span></div>
        <p className="line-clamp-3 whitespace-pre-wrap break-words text-[13px] text-ink">{message.text || "Shared file"}</p>
        {message.attachments?.length ? <p className="mt-1 truncate text-xs text-ink-secondary">{message.attachments.map(file => file.name).join(", ")}</p> : null}
        {opening === message.id && <span className="text-xs text-accent">Opening…</span>}
      </button>;
    })}</div>
    {loading && <p role="status" className="mt-2 text-xs text-ink-secondary">Searching…</p>}
    {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
    {!loading && (error || page?.hasMore) && <button type="button" className="mt-2 text-xs text-accent" onClick={() => void load(error ? undefined : page?.before ?? undefined)}>{error ? "Try again" : "Load earlier matches"}</button>}
  </section>;
}
