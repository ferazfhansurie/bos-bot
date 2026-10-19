import { useEffect, useRef, useState } from "react";
import { api, useStore } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";

export interface WhatsAppReplyPolicy {
  accountId: string;
  chatIds: string[] | null;
  autoDispatch: boolean;
  outreach?: boolean;
}
export interface WhatsAppPermissionChat { id: string; name: string; preview?: string }

export function whatsappPermissionGrant(accountId: string | null, chatIds: string[], outreach: boolean, autoDispatch: boolean): WhatsAppReplyPolicy {
  if (!accountId || !/^\d{6,20}@c\.us$/.test(accountId)) throw new Error("Link WhatsApp before granting access.");
  const unique = [...new Set(chatIds)];
  if (!unique.length || unique.length > 200 || unique.some((id) => !/^(\d{6,20}@c\.us|\d{6,25}@lid|[\d-]{6,40}@g\.us)$/.test(id) || id === accountId)) {
    throw new Error("Choose at least one chat, up to 200.");
  }
  return { accountId, chatIds: unique, autoDispatch, outreach };
}

export function WhatsAppPermissions() {
  const { state } = useStore();
  const bots = state.bots.filter((b) => !b.hidden && b.composio !== false);
  const [botId, setBotId] = useState(() => bots.find((b) => b.id === state.selectedId)?.id ?? bots[0]?.id ?? "");
  const [options, setOptions] = useState<{ accountId: string | null; chats: WhatsAppPermissionChat[] } | null>(null);
  const [policy, setPolicy] = useState<WhatsAppReplyPolicy | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [outreach, setOutreach] = useState(false);
  const [automatic, setAutomatic] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<{ botId: string; botName: string; grant: WhatsAppReplyPolicy; names: string[] } | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const request = ++generation.current;
    setLoading(true); setError(null); setNotice(null); setOptions(null); setSelected([]); setPolicy(null); setOutreach(false); setAutomatic(false); setReview(null);
    if (!botId) { setLoading(false); return; }
    void Promise.all([api("/api/whatsapp/permissions"), api(`/api/bots/${encodeURIComponent(botId)}/whatsapp-replies`)])
      .then(([nextOptions, result]) => {
        if (generation.current !== request) return;
        setOptions(nextOptions);
        const next = result.policy as WhatsAppReplyPolicy | null;
        setPolicy(next);
        // Never copy a grant across linked accounts or turn unrestricted access into outreach.
        if (next && next.accountId === nextOptions.accountId) {
          setSelected(next.chatIds ?? []); setOutreach(next.outreach === true); setAutomatic(next.autoDispatch === true);
        }
      })
      .catch((cause) => { if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current++; };
  }, [botId]);

  const save = async (target: string, value: WhatsAppReplyPolicy | null) => {
    const request = generation.current;
    setReview(null); setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api(`/api/bots/${encodeURIComponent(target)}/whatsapp-replies`, { method: "PUT", body: JSON.stringify(value) });
      if (generation.current === request) {
        setPolicy(result.policy); setSelected(result.policy?.chatIds ?? []);
        setOutreach(result.policy?.outreach === true); setAutomatic(result.policy?.autoDispatch === true);
        setNotice(value && value.chatIds?.length !== 0 ? "Access saved. It takes effect on the bot’s next turn." : "Chat access revoked.");
      }
    } catch (cause) { if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === request) setBusy(false); }
  };
  const beginReview = () => {
    try {
      const grant = whatsappPermissionGrant(options?.accountId ?? null, selected, outreach, automatic);
      setReview({ botId, botName: bots.find((b) => b.id === botId)?.name ?? botId, grant,
        names: selected.map((id) => options?.chats.find((c) => c.id === id)?.name ?? id) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const visible = options?.chats.filter((c) => `${c.name} ${c.id} ${c.preview ?? ""}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const unavailableSelected = selected.filter((id) => !options?.chats.some((c) => c.id === id));
  return <section className="mt-4 space-y-3 border-t border-hairline/35 pt-4" aria-label="WhatsApp bot permissions">
    <div><h3 className="text-[13px] font-medium text-ink">Bot permissions</h3><p className="mt-1 text-[12px] text-ink-secondary">Choose which chats a bot can read and reply to. Only the workspace owner can change this.</p></div>
    <label className="block text-[12px] text-ink-secondary">Bot
      <select aria-label="WhatsApp bot" value={botId} disabled={busy} onChange={(e) => setBotId(e.target.value)} className="mt-1 block w-full rounded-lg bg-raised p-2 text-ink">
        {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select>
    </label>
    {loading && <p role="status" className="text-[12px] text-ink-secondary">Checking owner permissions…</p>}
    {!loading && options && <>
      <p className="text-[12px] text-ink-secondary">{options.accountId ? `Linked account: +${options.accountId.replace(/@c\.us$/, "")}` : "Link WhatsApp before granting access."}</p>
      {!policy && <p className="text-[12px] text-ink-secondary">This bot can currently read captured chats. Replies and starting messages are disabled. Save selected chats to restrict access, or revoke all access below.</p>}
      {policy?.chatIds === null && <p className="text-[12px] text-ink-secondary">This bot currently has access to all chats. Saving a selection restricts it to those chats.</p>}
      {policy && policy.accountId !== options.accountId && <p className="text-[12px] text-danger">The saved permission belongs to a different account. Select chats to approve the current account.</p>}
      <input aria-label="Search WhatsApp chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full rounded-lg bg-raised p-2 text-[12px] text-ink" />
      <div className="max-h-48 overflow-y-auto rounded-lg border border-hairline/40 p-2">
        {visible.map((chat) => <label key={chat.id} className="flex items-start gap-2 py-1.5 text-[12px] text-ink">
          <input type="checkbox" disabled={busy} checked={selected.includes(chat.id)} onChange={(e) => setSelected((ids) => e.target.checked ? [...ids, chat.id] : ids.filter((id) => id !== chat.id))} />
          <span><span className="block">{chat.name}</span>{chat.preview && <span className="block text-ink-secondary">{chat.preview}</span>}</span>
        </label>)}
        {unavailableSelected.map((id) => <label key={id} className="flex items-center gap-2 py-1.5 text-[12px] text-ink"><input type="checkbox" checked disabled={busy} onChange={() => setSelected((ids) => ids.filter((item) => item !== id))} />{id} (saved chat)</label>)}
        {!visible.length && !unavailableSelected.length && <p className="text-[12px] text-ink-secondary">No matching captured chats.</p>}
      </div>
      <label className="flex items-center gap-2 text-[12px] text-ink"><input type="checkbox" checked={outreach} disabled={busy} onChange={(e) => setOutreach(e.target.checked)} />Allow this bot to start messages in selected chats</label>
      <label className="flex items-center gap-2 text-[12px] text-ink"><input type="checkbox" checked={automatic} disabled={busy} onChange={(e) => setAutomatic(e.target.checked)} />Reply automatically to new messages in selected chats</label>
      <div className="flex gap-2"><button type="button" disabled={busy || !options.accountId || !selected.length} onClick={beginReview} className="rounded-lg bg-raised px-3 py-2 text-[12px] text-ink disabled:opacity-40">Review access</button>
        {(policy || options.accountId) && <button type="button" disabled={busy} onClick={() => void save(botId, options.accountId ? { accountId: options.accountId, chatIds: [], autoDispatch: false, outreach: false } : null)} className="rounded-lg px-3 py-2 text-[12px] text-danger disabled:opacity-40">Revoke access</button>}</div>
    </>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[12px] text-ink-secondary">{notice}</p>}
    <ConfirmDialog open={review !== null} title="Allow WhatsApp access?" tone="neutral" confirmLabel="Allow selected chats"
      body={review ? `${review.botName} will be able to read and reply in: ${review.names.join(", ")}. Starting messages: ${review.grant.outreach ? "allowed" : "off"}. Automatic replies: ${review.grant.autoDispatch ? "on" : "off"}.` : ""}
      onCancel={() => setReview(null)} onConfirm={() => { if (review) void save(review.botId, review.grant); }} />
  </section>;
}
