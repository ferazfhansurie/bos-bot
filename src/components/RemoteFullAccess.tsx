import { useEffect, useState } from "react";
type Candidate = { botId: string; threadId: string; name: string; busy: boolean };
/** Selection is an untrusted request. Electron independently fetches the exact
 * server snapshot and owns both sign-in and the final confirmation dialog. */
export function RemoteFullAccess({ botId, threadId, busy, candidates }: { botId: string; threadId: string; busy: boolean; candidates: Candidate[] }) {
  const [available, setAvailable] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void window.ogb?.remoteApprovals?.status().then(s => { if (alive) setAvailable(s.protocol === 1 && s.enrolled); }).catch(() => {});
    return () => { alive = false; };
  }, [botId, threadId]);
  if (!available) return null;
  return <span className="relative"><button type="button" className="h-8 rounded-full border border-hairline/20 px-3 text-[13px]" disabled={busy || pending}
    onClick={() => { setSelected([botId]); setError(""); setOpen(true); }}>{pending ? "Confirming…" : "Full access…"}</button>
    {open && <div role="dialog" aria-label="Review remote Full access" className="absolute bottom-10 left-0 z-50 w-80 rounded-lg border border-hairline/30 bg-raised p-4 shadow-lg">
      <p>Choose bots. Full applies to each bot default and its selected task. Other existing tasks keep their access.</p>
      {candidates.map(c => <label key={c.botId} className="my-2 block"><input type="checkbox" checked={selected.includes(c.botId)} disabled={pending || c.busy}
        onChange={event => setSelected(ids => event.target.checked ? [...ids, c.botId].slice(0, 8) : ids.filter(id => id !== c.botId))} /> {c.name} · {c.threadId}</label>)}
      <button type="button" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
      <button type="button" disabled={pending || selected.length === 0 || candidates.some(c => selected.includes(c.botId) && c.busy)} onClick={async () => {
        const targets = candidates.filter(c => selected.includes(c.botId)).map(c => ({ botId: c.botId, threadId: c.botId === botId ? threadId : c.threadId, updateBotDefault: true }));
        setPending(true); setError("");
        try { await window.ogb!.remoteApprovals!.request(targets); setOpen(false); }
        catch { setError("Full access was not confirmed. Check the installation owner, enrollment and selected tasks, then try again."); }
        finally { setPending(false); }
      }}>Review with owner</button>
      {error && <p role="alert">{error}</p>}
    </div>}
  </span>;
}
