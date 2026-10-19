import { useEffect, useState } from "react";
import { api } from "@/state/store";
import { memorySourceIds } from "../../shared/memory-source";

type Source = { id: string; path: string; hash: string; text: string; line: number };
/** Render only server-validated explicit citations on this exact answer. */
export function AnswerMemorySources({ botId, threadId, messageId, text }: { botId: string; threadId: string; messageId: string; text: string }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [checked, setChecked] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [replacement, setReplacement] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string>();
  const ids = memorySourceIds(text).join(",");
  const endpoint = `/api/bots/${encodeURIComponent(botId)}/answers/${encodeURIComponent(messageId)}/memory-sources?threadId=${encodeURIComponent(threadId)}`;
  useEffect(() => {
    setSources([]); setChecked(false); setEditing(undefined); setError(""); setSaved(undefined);
    if (!ids) return;
    const controller = new AbortController();
    void api<{ sources: Source[] }>(endpoint, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setSources(result.sources); setChecked(true); } }).catch(() => { if (!controller.signal.aborted) setChecked(true); });
    return () => controller.abort();
  }, [endpoint, ids]);
  const save = async (source: Source, remove: boolean) => {
    setBusy(true); setError("");
    try {
      await api(endpoint, { method: "PATCH", body: JSON.stringify({ sourceId: source.id, expectedHash: source.hash, replacement: remove ? "" : replacement }) });
      setSaved(source.id); setEditing(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "could not update this memory entry"); }
    finally { setBusy(false); }
  };
  if (!ids) return null;
  if (!sources.length) return <p className="mt-2 text-[12px] text-ink-secondary">{checked ? "the cited memory source could not be verified." : "checking cited memory…"}</p>;
  return <div className="mt-3 border-t border-hairline/30 pt-2 text-[12px] text-ink-secondary" aria-label="memory sources for this answer">
    {sources.map(source => <details key={source.id} className="mt-1">
      <summary className="cursor-pointer">memory source: {source.path}:{source.line}</summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{source.text}</p>
      {saved === source.id ? <p role="status">memory updated. this answer keeps its original source for context.</p> : editing === source.id ? <div className="mt-2 space-y-2">
        <label className="block">correct this exact entry<textarea aria-label="correct memory entry" className="mt-1 block w-full rounded border border-hairline bg-inset p-2" rows={3} maxLength={4000} value={replacement} onChange={event => setReplacement(event.target.value)} /></label>
        <button disabled={busy || !replacement.trim()} onClick={() => void save(source, false)} className="mr-3 text-accent-text">save correction</button>
        <button disabled={busy} onClick={() => void save(source, true)} className="mr-3 text-danger">remove entry</button>
        <button disabled={busy} onClick={() => setEditing(undefined)}>cancel</button>
      </div> : <button className="mt-2 text-accent-text" onClick={() => { setEditing(source.id); setReplacement(source.text); setError(""); }}>correct or remove this memory</button>}
    </details>)}
    {error && <p role="alert" className="mt-2 text-danger">{error}</p>}
  </div>;
}
