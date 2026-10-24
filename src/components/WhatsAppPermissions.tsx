import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Search, User, Users } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./SettingsPrimitives";

export interface WhatsAppReplyPolicy {
  accountId: string;
  chatIds: string[] | null;
  autoDispatch: boolean;
  outreach?: boolean;
  readAll?: boolean;
  readOnly?: boolean;
}
export interface WhatsAppPermissionChat { id: string; name: string | null; preview?: string; group?: boolean; lastAt?: number; fromMe?: boolean }

export type WhatsAppReading = "all" | "chosen" | "off";
export interface WhatsAppAccessChoice { reading: WhatsAppReading; replying: boolean; chatIds: string[]; outreach: boolean; autoDispatch: boolean }

const chatId = /^(\d{6,20}@c\.us|\d{6,25}@lid|[\d-]{6,40}@g\.us)$/;

/** The exact policy an owner's choice saves. Reading all with replies off is
 * read-only by construction; replies always need named chats. */
export function whatsappPermissionGrant(accountId: string | null, choice: WhatsAppAccessChoice): WhatsAppReplyPolicy {
  if (!accountId || !/^\d{6,20}@c\.us$/.test(accountId)) throw new Error("Link WhatsApp before granting access.");
  if (choice.reading === "off") return { accountId, chatIds: [], autoDispatch: false, outreach: false, readAll: false };
  const unique = [...new Set(choice.chatIds)];
  if (unique.length > 200 || unique.some((id) => !chatId.test(id) || id === accountId)) throw new Error("Choose up to 200 chats.");
  if (choice.reading === "all" && !choice.replying) return { accountId, chatIds: [], autoDispatch: false, outreach: false, readAll: true };
  if (!unique.length) throw new Error(choice.replying ? "Choose at least one chat the bot can reply in." : "Choose at least one chat the bot can read.");
  if (!choice.replying) return { accountId, chatIds: unique, autoDispatch: false, outreach: false, readOnly: true };
  return { accountId, chatIds: unique, autoDispatch: choice.autoDispatch, outreach: choice.outreach, ...(choice.reading === "all" ? { readAll: true } : {}) };
}

/** What the saved policy means, in the same terms as the controls. No policy
 * is the server default: every captured chat readable, nothing sendable. */
export function whatsappAccessChoice(policy: WhatsAppReplyPolicy | null): WhatsAppAccessChoice {
  if (!policy) return { reading: "all", replying: false, chatIds: [], outreach: false, autoDispatch: false };
  const chatIds = policy.chatIds ?? [];
  const reading: WhatsAppReading = policy.readAll || policy.chatIds === null ? "all" : chatIds.length ? "chosen" : "off";
  const replying = reading !== "off" && policy.readOnly !== true && (policy.chatIds === null || chatIds.length > 0);
  return { reading, replying, chatIds, outreach: replying && policy.outreach === true, autoDispatch: replying && policy.autoDispatch === true };
}

export function whatsappAccessSummary(bot: string, choice: WhatsAppAccessChoice, chatCount: number): string {
  if (choice.reading === "off") return `${bot} can't read or reply in WhatsApp.`;
  const n = choice.chatIds.length, chats = `${n} chat${n === 1 ? "" : "s"}`;
  const read = choice.reading === "all" ? `${bot} can read all your chats${chatCount ? ` (${chatCount} so far)` : ""}, including new ones.` : `${bot} can read ${chats}.`;
  if (!choice.replying) return `${read} Replies are off.`;
  const extras = [choice.outreach && "start new messages", choice.autoDispatch && "reply on its own"].filter(Boolean).join(" and ");
  return `${read} It can reply in ${choice.reading === "all" ? chats : "them"} when asked${extras ? `, and ${extras}` : ""}.`;
}

/** Equal when two choices would save the same policy. */
function canonical(c: WhatsAppAccessChoice): string {
  if (c.reading === "off") return "off";
  const ids = c.reading === "all" && !c.replying ? [] : [...c.chatIds].sort();
  return JSON.stringify([c.reading, c.replying, ids, c.replying && c.outreach, c.replying && c.autoDispatch]);
}

function formatPhone(id: string): string | null {
  const digits = id.match(/^(\d{6,20})@c\.us$/)?.[1];
  if (!digits) return null;
  return digits.startsWith("60") ? `+60 ${digits.slice(2, 4)}-${digits.slice(4, 7)} ${digits.slice(7)}` : `+${digits}`;
}

export function whatsappChatLabel(chat: WhatsAppPermissionChat): string {
  return chat.name || formatPhone(chat.id) || (chat.group ? "Unnamed group" : "Unknown contact");
}

function when(seconds?: number): string {
  if (!seconds) return "";
  const date = new Date(seconds * 1000), now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function initials(label: string): string {
  const words = label.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "#";
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}

const readingOptions: { value: WhatsAppReading; label: string }[] = [
  { value: "all", label: "All chats" },
  { value: "chosen", label: "Chosen chats" },
  { value: "off", label: "Off" },
];

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return <div className="rounded-xl bg-raised/60 p-3">
    <div className="text-[12.5px] font-medium text-ink">{title}</div>
    {hint && <div className="mt-0.5 text-[11.5px] leading-relaxed text-ink-secondary">{hint}</div>}
    <div className="mt-2.5">{children}</div>
  </div>;
}

function ToggleRow({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <div className="flex items-center justify-between gap-3 py-1.5">
    <div className="min-w-0"><div className="text-[12.5px] text-ink">{label}</div>{hint && <div className="text-[11.5px] text-ink-secondary">{hint}</div>}</div>
    <Switch checked={checked} disabled={disabled} aria-label={label} onClick={() => onChange(!checked)} />
  </div>;
}

export function WhatsAppPermissions() {
  const { state } = useStore();
  const bots = state.bots.filter((b) => !b.hidden && b.composio !== false);
  const [botId, setBotId] = useState(() => bots.find((b) => b.id === state.selectedId)?.id ?? bots[0]?.id ?? "");
  const [options, setOptions] = useState<{ accountId: string | null; chats: WhatsAppPermissionChat[] } | null>(null);
  const [policy, setPolicy] = useState<WhatsAppReplyPolicy | null>(null);
  const [choice, setChoice] = useState<WhatsAppAccessChoice>(() => whatsappAccessChoice(null));
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | "groups" | "people">("all");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<{ botId: string; grant: WhatsAppReplyPolicy; summary: string } | null>(null);
  const generation = useRef(0);
  const firstBot = bots.find((b) => b.id === state.selectedId)?.id ?? bots[0]?.id ?? "";
  // The bot list can arrive after the panel mounts.
  useEffect(() => { if (!botId && firstBot) setBotId(firstBot); }, [botId, firstBot]);
  const botName = bots.find((b) => b.id === botId)?.name ?? "This bot";

  useEffect(() => {
    const request = ++generation.current;
    setLoading(true); setError(null); setNotice(null); setOptions(null); setPolicy(null); setChoice(whatsappAccessChoice(null)); setReview(null);
    if (!botId) { setLoading(false); return; }
    void Promise.all([api("/api/whatsapp/permissions"), api(`/api/bots/${encodeURIComponent(botId)}/whatsapp-replies`)])
      .then(([nextOptions, result]) => {
        if (generation.current !== request) return;
        setOptions(nextOptions);
        const next = result.policy as WhatsAppReplyPolicy | null;
        setPolicy(next);
        // Never copy a grant across linked accounts.
        setChoice(whatsappAccessChoice(next && next.accountId === nextOptions.accountId ? next : null));
      })
      .catch((cause) => { if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (generation.current === request) setLoading(false); });
    return () => { generation.current++; };
  }, [botId]);

  const saved = whatsappAccessChoice(policy && policy.accountId === options?.accountId ? policy : null);
  const dirty = !policy || policy.accountId !== options?.accountId || canonical(saved) !== canonical(choice);
  const update = (patch: Partial<WhatsAppAccessChoice>) => { setNotice(null); setError(null); setChoice((c) => ({ ...c, ...patch })); };

  const save = async (target: string, value: WhatsAppReplyPolicy) => {
    const request = generation.current;
    setReview(null); setBusy(true); setError(null); setNotice(null);
    try {
      const result = await api(`/api/bots/${encodeURIComponent(target)}/whatsapp-replies`, { method: "PUT", body: JSON.stringify(value) });
      if (generation.current === request) {
        setPolicy(result.policy); setChoice(whatsappAccessChoice(result.policy));
        setNotice(value.chatIds?.length || value.readAll ? "Saved. It applies from the bot's next message." : "Access turned off.");
      }
    } catch (cause) { if (generation.current === request) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (generation.current === request) setBusy(false); }
  };
  const beginReview = () => {
    try {
      const grant = whatsappPermissionGrant(options?.accountId ?? null, choice);
      if (choice.reading === "off") { void save(botId, grant); return; }
      setReview({ botId, grant, summary: whatsappAccessSummary(botName, choice, options?.chats.length ?? 0) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const chats = options?.chats ?? [];
  const visible = useMemo(() => chats.filter((c) =>
    (kind === "all" || (kind === "groups") === !!c.group) &&
    `${whatsappChatLabel(c)} ${c.id} ${c.preview ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())), [chats, kind, query]);
  const unavailable = choice.chatIds.filter((id) => !chats.some((c) => c.id === id));
  const picking = choice.reading === "chosen" || (choice.reading === "all" && choice.replying);
  const toggleChat = (id: string, on: boolean) => update({ chatIds: on ? [...new Set([...choice.chatIds, id])] : choice.chatIds.filter((x) => x !== id) });
  const allShown = visible.length > 0 && visible.every((c) => choice.chatIds.includes(c.id));

  return <section className="mt-4 space-y-3 border-t border-hairline/35 pt-4" aria-label="WhatsApp bot permissions">
    <div className="flex items-start justify-between gap-3">
      <div><h3 className="text-[13px] font-medium text-ink">Bot access</h3>
        <p className="mt-0.5 text-[12px] text-ink-secondary">{options?.accountId ? `${formatPhone(options.accountId) ?? options.accountId} · only you can change this` : "Only the workspace owner can change this."}</p></div>
      <select aria-label="WhatsApp bot" value={botId} disabled={busy} onChange={(e) => setBotId(e.target.value)}
        className="max-w-[45%] rounded-lg bg-raised px-2.5 py-1.5 text-[12.5px] text-ink">
        {bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
      </select>
    </div>

    {loading && <p role="status" className="text-[12px] text-ink-secondary">Loading chats…</p>}
    {!loading && options && !options.accountId && <p className="text-[12px] text-ink-secondary">Link WhatsApp before granting access.</p>}
    {!loading && options?.accountId && <>
      {policy && policy.accountId !== options.accountId && <p className="rounded-lg bg-danger/10 px-3 py-2 text-[12px] text-danger">The saved access belongs to a different WhatsApp account. Save again to apply it to this one.</p>}
      {policy?.chatIds === null && <p className="rounded-lg bg-raised px-3 py-2 text-[12px] text-ink-secondary">This bot has older full access (read and reply anywhere). Saving switches it to the settings below.</p>}

      <Section title="Reading" hint="Which chats the bot can read for summaries and tracking.">
        <div role="radiogroup" aria-label="Reading" className="grid grid-cols-3 gap-1 rounded-lg bg-ink/[.05] p-1">
          {readingOptions.map((o) => <button key={o.value} type="button" role="radio" aria-checked={choice.reading === o.value} disabled={busy}
            onClick={() => update(o.value === "off" ? { reading: "off", replying: false, outreach: false, autoDispatch: false } : { reading: o.value })}
            className={cn("rounded-md py-1.5 text-[12px] transition-colors", choice.reading === o.value ? "bg-ink/[.12] font-medium text-ink shadow-sm" : "text-ink-secondary hover:text-ink")}>{o.label}</button>)}
        </div>
        {choice.reading === "all" && <p className="mt-2 text-[11.5px] text-ink-secondary">Includes new chats and groups as they come in.</p>}
      </Section>

      <Section title="Replying" hint={choice.reading === "off" ? "Turn reading on first." : "Off means the bot only reads. It never sends anything."}>
        <ToggleRow label="Let the bot reply" hint={choice.reading === "off" ? undefined : choice.reading === "all" ? "Only in chats you choose below" : "In the chats you choose below"} checked={choice.replying} disabled={busy || choice.reading === "off"}
          onChange={(on) => update(on ? { replying: true } : { replying: false, outreach: false, autoDispatch: false })} />
        {choice.replying && <div className="mt-1 border-t border-hairline/30 pt-1">
          <ToggleRow label="Start new messages" hint="Follow up without waiting for them" checked={choice.outreach} disabled={busy} onChange={(on) => update({ outreach: on })} />
          <ToggleRow label="Reply automatically" hint="Answer new messages without asking you" checked={choice.autoDispatch} disabled={busy} onChange={(on) => update({ autoDispatch: on })} />
        </div>}
      </Section>

      {picking && <Section title={choice.reading === "chosen" ? (choice.replying ? "Chats it can read and reply in" : "Chats it can read") : "Chats it can reply in"}>
        <div className="flex items-center gap-2">
          <label className="flex flex-1 items-center gap-2 rounded-lg bg-raised px-2.5 py-1.5">
            <Search size={13} className="shrink-0 text-ink-secondary" />
            <input aria-label="Search WhatsApp chats" placeholder="Search chats" value={query} onChange={(e) => setQuery(e.target.value)} className="w-full bg-transparent text-[12.5px] text-ink outline-none placeholder:text-ink-secondary" />
          </label>
          <div role="radiogroup" aria-label="Chat type" className="flex rounded-lg bg-ink/[.05] p-0.5">
            {(["all", "groups", "people"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
              className={cn("rounded-md px-2 py-1 text-[11.5px] capitalize", kind === k ? "bg-ink/[.12] text-ink" : "text-ink-secondary hover:text-ink")}>{k}</button>)}
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between px-0.5 text-[11.5px] text-ink-secondary">
          <span>{choice.chatIds.length} chosen</span>
          <span className="flex gap-3">
            <button type="button" disabled={busy || !visible.length} className="hover:text-ink disabled:opacity-40"
              onClick={() => update({ chatIds: allShown ? choice.chatIds.filter((id) => !visible.some((c) => c.id === id)) : [...new Set([...choice.chatIds, ...visible.map((c) => c.id)])].slice(0, 200) })}>
              {allShown ? "Unselect shown" : `Select ${visible.length === chats.length ? "all" : "shown"}`}</button>
            {choice.chatIds.length > 0 && <button type="button" disabled={busy} className="hover:text-ink" onClick={() => update({ chatIds: [] })}>Clear</button>}
          </span>
        </div>
        <ul className="mt-1.5 max-h-64 overflow-y-auto rounded-lg border border-hairline/30" aria-label="WhatsApp chats">
          {visible.map((chat) => {
            const on = choice.chatIds.includes(chat.id), label = whatsappChatLabel(chat);
            return <li key={chat.id}>
              <button type="button" role="checkbox" aria-checked={on} disabled={busy} onClick={() => toggleChat(chat.id, !on)} title={chat.id}
                className={cn("flex w-full items-center gap-2.5 border-b border-hairline/20 px-2.5 py-2 text-left transition-colors last:border-b-0", on ? "bg-accent/10" : "hover:bg-ink/[.04]")}>
                <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border", on ? "border-accent bg-accent text-white" : "border-hairline")}>{on && <Check size={11} strokeWidth={3} />}</span>
                <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink/[.08] text-[11px] font-medium text-ink-secondary">{chat.group ? <Users size={14} /> : chat.name ? initials(label) : <User size={14} />}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2"><span className={cn("truncate text-[12.5px]", chat.name ? "text-ink" : "text-ink-secondary")}>{label}</span>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-secondary">{when(chat.lastAt)}</span></span>
                  {chat.preview && <span className="block truncate text-[11.5px] text-ink-secondary">{chat.fromMe ? "You: " : ""}{chat.preview}</span>}
                </span>
              </button>
            </li>;
          })}
          {unavailable.map((id) => <li key={id}>
            <button type="button" role="checkbox" aria-checked disabled={busy} onClick={() => toggleChat(id, false)} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-[12px] text-ink-secondary">
              <span className="flex h-4 w-4 items-center justify-center rounded-[5px] border border-accent bg-accent text-white"><Check size={11} strokeWidth={3} /></span>{id} (no recent messages)</button>
          </li>)}
          {!visible.length && !unavailable.length && <li className="px-3 py-4 text-center text-[12px] text-ink-secondary">{chats.length ? "No chats match." : "No captured chats yet."}</li>}
        </ul>
      </Section>}

      <div className="flex items-center gap-3 pt-0.5">
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-secondary">{whatsappAccessSummary(botName, choice, chats.length)}</p>
        <button type="button" disabled={busy || !dirty || (picking && !choice.chatIds.length)} onClick={beginReview}
          className="shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40">{busy ? "Saving…" : "Save"}</button>
      </div>
    </>}
    {error && <p role="alert" className="text-[12px] text-danger">{error}</p>}
    {notice && <p role="status" className="text-[12px] text-success">{notice}</p>}
    <ConfirmDialog open={review !== null} title="Save WhatsApp access?" tone="neutral" confirmLabel="Save access"
      body={review?.summary ?? ""}
      onCancel={() => setReview(null)} onConfirm={() => { if (review) void save(review.botId, review.grant); }} />
  </section>;
}
