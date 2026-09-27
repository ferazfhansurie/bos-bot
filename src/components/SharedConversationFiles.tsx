import { useEffect, useRef, useState } from "react";
import { Paperclip } from "lucide-react";
import { api } from "@/state/store";
import { SharedAttachmentTile } from "./SharedAttachmentTile";
import type { SharedContact, SharedFile, SharedFilesPage } from "./shared-conversation";

export function SharedConversationFiles({ roomId, selfId, contacts, onShowMessage }: {
  roomId: string; selfId: string; contacts: SharedContact[];
  onShowMessage: (file: SharedFile) => Promise<void>;
}) {
  const [page, setPage] = useState<SharedFilesPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [opening, setOpening] = useState<string | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const load = async (before?: number) => {
    if (busy.current) return;
    busy.current = true; setLoading(true); setError("");
    try {
      const next = await api<SharedFilesPage>(`/api/multiplayer/rooms/${roomId}/files?limit=30${before ? `&before=${before}` : ""}`);
      if (alive.current) setPage(previous => ({ ...next, files: before && previous ? [...previous.files, ...next.files.filter(file => !previous.files.some(old => old.messageId === file.messageId && old.attachment.id === file.attachment.id))] : next.files }));
    } catch { if (alive.current) setError("Could not load shared files. Try again."); }
    finally { busy.current = false; if (alive.current) setLoading(false); }
  };
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [roomId]);
  const show = async (file: SharedFile) => {
    setOpening(file.messageId); setError("");
    try { await onShowMessage(file); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "Could not open the message."); }
    finally { if (alive.current) setOpening(null); }
  };
  return <section aria-label="Shared files">
    <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink"><Paperclip size={16} />Shared files</h3>
    {page?.files.length === 0 && <p className="text-[13px] text-ink-secondary">Images and documents shared here will appear here.</p>}
    <div className="space-y-3">{page?.files.map(file => {
      const actorId = `${file.actor.homeId}:${file.actor.kind}:${file.actor.localId}`;
      const author = actorId === selfId ? "You" : contacts.find(contact => contact.id === actorId)?.name ?? (file.actor.kind === "bot" ? "Bot" : "Member");
      return <div key={`${file.messageId}:${file.attachment.id}`} className="rounded-xl border border-hairline/40 p-2">
        <SharedAttachmentTile roomId={roomId} attachment={file.attachment} compact />
        <div className="mt-2 flex items-center gap-2 px-1 text-xs text-ink-secondary"><span className="min-w-0 flex-1 truncate">{author} · {new Date(file.at).toLocaleDateString()} · {file.attachment.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.attachment.size / 1024))} KB` : `${(file.attachment.size / 1024 / 1024).toFixed(1)} MB`}</span>
          <button type="button" disabled={opening !== null} onClick={() => void show(file)} className="shrink-0 text-accent disabled:opacity-50" aria-label={`Show message for ${file.attachment.name}`}>{opening === file.messageId ? "Opening…" : "Show message"}</button></div>
      </div>;
    })}</div>
    {loading && <p role="status" className="mt-3 text-xs text-ink-secondary">Loading files…</p>}
    {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
    {!loading && (!page || page.hasMore) && <button type="button" onClick={() => void load(page?.before ?? undefined)} className="mt-3 text-[13px] text-accent">{error ? "Try again" : "Load earlier files"}</button>}
  </section>;
}
