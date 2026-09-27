import { useEffect, useRef, useState } from "react";
import { Bell, LogOut, Trash2, Users, X } from "lucide-react";
import { GroupMark, PersonPhoto } from "./Avatar";
import { ConfirmDialog } from "./ConfirmDialog";
import { isDirectSharedRoom, type SharedContact, type SharedRoom, type SharedPreferences, type SharedNotifications } from "./shared-conversation";

export function SharedConversationDetails({ room, selfId, contacts, title, pending, error, onClose, onChange, preferences, preferencePending, preferenceError, onNotificationsChange }: {
  room: SharedRoom; selfId: string; contacts: SharedContact[]; title: string;
  pending: boolean; error: string; onClose: () => void;
  onChange: (method: "PATCH" | "DELETE" | "POST", suffix: string, patch?: Record<string, unknown>) => Promise<boolean>;
  preferences?: SharedPreferences | null; preferencePending?: boolean; preferenceError?: string;
  onNotificationsChange?: (value: SharedNotifications) => Promise<void>;
}) {
  const [name, setName] = useState(room.name);
  const [peopleQuery, setPeopleQuery] = useState("");
  const [confirm, setConfirm] = useState<"delete" | "leave" | string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const direct = isDirectSharedRoom(room);
  const ownerId = room.createdBy ?? `${room.homeId}:person:owner`;
  const canManage = selfId === ownerId || selfId === `${room.homeId}:person:owner`;
  const members = room.memberIds.map(id => contacts.find(contact => contact.id === id)
    ?? { id, name: id === selfId ? "You" : "Member", kind: "person" as const });
  const available = contacts.filter(contact => contact.kind === "person" && !room.memberIds.includes(contact.id));

  useEffect(() => setName(room.name), [room.name]);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);
  const apply = async () => {
    const action = confirm;
    setConfirm(null);
    if (action === "delete") await onChange("DELETE", "");
    else if (action === "leave") await onChange("POST", "/leave");
    else if (action) await onChange("PATCH", "", { memberIds: room.memberIds.filter(id => id !== action) });
  };
  const target = members.find(member => member.id === confirm);

  return <>
    <aside ref={panelRef} role="dialog" aria-labelledby="shared-details-title" tabIndex={-1}
      onKeyDown={event => {
        if (event.key === "Escape" && !confirm) { event.stopPropagation(); onClose(); }
      }}
      className="animate-panel-in absolute inset-0 z-40 flex h-full min-w-0 flex-col border-l border-hairline/40 bg-panel outline-none lg:static lg:z-auto lg:w-[min(420px,42vw)] lg:shrink-0">
      <div className="flex shrink-0 items-center justify-between px-4 py-3">
        <h2 id="shared-details-title" className="text-[15px] font-semibold text-ink">Conversation details</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close conversation details" className="rounded-md p-1 text-ink-secondary hover:bg-control hover:text-ink"><X size={18} /></button>
      </div>
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 pb-6">
        <div className="flex flex-col items-center gap-3 rounded-xl bg-control/50 px-4 py-5">
          <GroupMark members={direct ? members.filter(member => member.id !== selfId) : members} size={64} />
          <div className="text-center"><h3 className="break-words text-lg font-semibold text-ink">{title}</h3><p className="mt-1 text-xs text-ink-secondary">{direct ? "Direct conversation" : `${members.length} members`}</p></div>
        </div>
        {!direct && <form onSubmit={event => { event.preventDefault(); if (name.trim()) void onChange("PATCH", "", { name: name.trim() }); }}>
          <label htmlFor="shared-room-name" className="mb-2 block text-xs font-medium text-ink-secondary">Group name</label>
          <div className="flex gap-2"><input id="shared-room-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} disabled={pending} className="min-w-0 flex-1 rounded-lg bg-control px-3 py-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent" />
          {<button type="submit" disabled={pending || !name.trim() || name.trim() === room.name} className="rounded-lg bg-accent px-3 text-sm text-white disabled:opacity-40">Save</button>}</div>
          {!canManage && <p className="mt-2 text-xs text-ink-secondary">Only the owner can change members.</p>}
        </form>}
        <section aria-label="Conversation members">
          <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-ink"><Users size={16} />Members · {members.length}</h3>
          <div className="space-y-3">{members.map(member => <div key={member.id} className="flex items-center gap-3">
            {member.avatar ? <PersonPhoto src={member.avatar} size={34} /> : <GroupMark members={[member]} size={34} />}
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium text-ink">{member.name}{member.id === selfId && member.name !== "You" ? " (you)" : ""}</div><div className="text-xs text-ink-secondary">{member.id === ownerId ? "Owner" : "Member"}{member.title ? ` · ${member.title}` : ""}</div></div>
            {!direct && canManage && member.id !== selfId && member.id !== ownerId && <button type="button" disabled={pending} onClick={() => setConfirm(member.id)} className="rounded-md px-2 py-1 text-xs text-danger hover:bg-danger/10">Remove</button>}
          </div>)}</div>
          {!direct && canManage && available.length > 0 && <div className="mt-4 rounded-xl border border-hairline/40 bg-control/40 p-2">
            <input aria-label="Find people to add" placeholder="Find people…" value={peopleQuery} onChange={event => setPeopleQuery(event.target.value)} className="mb-2 w-full rounded-lg bg-inset px-3 py-2 text-sm text-ink outline-none focus:ring-1 focus:ring-accent" />
            <div className="max-h-48 space-y-1 overflow-y-auto">{available.filter(contact => contact.name.toLowerCase().includes(peopleQuery.toLowerCase())).map(contact => <button key={contact.id} type="button" value={contact.id} disabled={pending} aria-label={`Add ${contact.name}`} onClick={() => void onChange("PATCH", "", { memberIds: [...room.memberIds, contact.id] }).then(ok => { if (ok) setPeopleQuery(""); })} className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left hover:bg-control disabled:opacity-40">
              {contact.avatar ? <PersonPhoto src={contact.avatar} size={28} /> : <GroupMark members={[contact]} size={28} />}
              <span className="min-w-0 flex-1 truncate text-sm text-ink">{contact.name}</span><span className="text-xs font-medium text-accent">Add</span>
            </button>)}</div>
            {!available.some(contact => contact.name.toLowerCase().includes(peopleQuery.toLowerCase())) && <p className="px-2 py-3 text-xs text-ink-secondary">No matching people</p>}
          </div>}

        </section>
        <p className="rounded-xl bg-accent/10 px-3 py-3 text-[13px] leading-relaxed text-ink-secondary">@mention your bots here — no need to add them</p>
        {onNotificationsChange && <section aria-label="Conversation notifications">
          <label htmlFor="shared-notifications" className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink"><Bell size={16} />Notifications</label>
          <select id="shared-notifications" value={preferences?.notifications ?? "all"} disabled={!preferences || preferencePending}
            onChange={event => void onNotificationsChange(event.target.value as SharedNotifications)} className="w-full rounded-lg bg-control px-3 py-2 text-sm text-ink disabled:opacity-50">
            <option value="all">All messages</option><option value="mentions">Mentions and my bot requests</option><option value="muted">Muted</option>
          </select>
          {preferencePending && <p role="status" className="mt-2 text-xs text-ink-secondary">Saving…</p>}
          {preferenceError && <p role="alert" className="mt-2 text-xs text-danger">{preferenceError}</p>}
        </section>}
        {error && <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="space-y-2 border-t border-hairline/40 pt-4">
          {!direct && <button type="button" disabled={pending} onClick={() => setConfirm("leave")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-secondary hover:bg-control disabled:opacity-40"><LogOut size={16} />Leave group</button>}
          {canManage && <button type="button" disabled={pending} onClick={() => setConfirm("delete")} className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-danger hover:bg-danger/10 disabled:opacity-40"><Trash2 size={16} />Delete for everyone</button>}
        </div>
      </div>
    </aside>
    <ConfirmDialog open={confirm !== null} title={confirm === "delete" ? `Delete ${title}?` : confirm === "leave" ? `Leave ${title}?` : `Remove ${target?.name ?? "member"}?`}
      body={confirm === "delete" ? "This deletes the conversation and its history for every member. This cannot be undone." : confirm === "leave" ? "You will lose access to this conversation. Another member will need to add you again." : "This person will lose access to the conversation."}
      confirmLabel={confirm === "delete" ? "Delete for everyone" : confirm === "leave" ? "Leave group" : "Remove member"}
      onCancel={() => setConfirm(null)} onConfirm={() => void apply()} returnFocusRef={closeRef} />
  </>;
}
