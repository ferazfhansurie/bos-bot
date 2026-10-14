import { useCallback, useEffect, useState } from "react";
import { Check, ChevronRight, ClipboardCopy, Copy, MessageCircle, Pin, PinOff, UserPlus } from "lucide-react";
import { api, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import type { ReactNode } from "react";
import { readSessionState } from "@/lib/session";
import { GroupMark, PersonPhoto } from "./Avatar";
import { isDirectSharedRoom, sharedRoomUnread, sidebarPeople } from "./shared-conversation";
import { openRowMenu, RowContextMenu, type RowMenuAt, type RowMenuItem } from "./RowContextMenu";

interface Contact { id: string; name: string; kind: "person" | "bot"; homeId?: string; homeName?: string; title?: string; avatar?: string | null; color?: string | null; mascotBody?: string | null }
interface Room { id: string; name: string; kind?: "direct" | "group"; memberIds: string[]; lastActivity?: number; preview?: string; unreadCount?: number; readSequence?: number; notifications?: "all" | "mentions" | "muted" }
export interface LocalConversationRow { id: string; at: number; pinned?: boolean; element: ReactNode }

/** Remote people and person rooms share the conversation list with local bots.
 * Bots on a linked Mac arrive through the bot list itself, never here. */
export function SharedContactsSidebar({ compact = false, placement = "people", localRows = [] }: { compact?: boolean; placement?: "people" | "unified"; localRows?: LocalConversationRow[]; density?: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const [selfId, setSelfId] = useState<string | null>(null);
  // everyone the roster knows (room faces and names), and the people worth a row
  const [roster, setRoster] = useState<Contact[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [seenRooms, setSeenRooms] = useState<Record<string, number>>(() => {
    try { return JSON.parse(globalThis.localStorage?.getItem("bos.shared-room-seen") ?? "{}"); }
    catch { return {}; }
  });
  const [error, setError] = useState("");
  const [peopleOpen, setPeopleOpen] = useState(() => globalThis.localStorage?.getItem("bos.sidebar.people-open") === "1");
  const togglePeople = (open: boolean) => {
    setPeopleOpen(open);
    try { globalThis.localStorage?.setItem("bos.sidebar.people-open", open ? "1" : "0"); } catch { /* private mode */ }
  };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowMenu, setRowMenu] = useState<{ at: RowMenuAt; label: string; items: RowMenuItem[] } | null>(null);
  const closeRowMenu = useCallback(() => setRowMenu(null), []);
  const [pins, setPins] = useState<string[]>(() => {
    try { const stored = JSON.parse(globalThis.localStorage?.getItem("bos.sidebar.pinned-people") ?? "[]"); return Array.isArray(stored) ? stored.filter((v): v is string => typeof v === "string") : []; }
    catch { return []; }
  });
  const togglePin = (id: string) => setPins(current => {
    const next = current.includes(id) ? current.filter(p => p !== id) : [...current, id];
    try { globalThis.localStorage?.setItem("bos.sidebar.pinned-people", JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });
  const pinItem = (id: string): RowMenuItem => pins.includes(id)
    ? { key: "pin", label: "Unpin", icon: <PinOff size={16} className="text-ink-secondary" />, onSelect: () => togglePin(id) }
    : { key: "pin", label: "Pin", icon: <Pin size={16} className="text-ink-secondary" />, onSelect: () => togglePin(id) };
  const [owner, setOwner] = useState(false);
  const [settingUp, setSettingUp] = useState(false);
  const [pairingUrl, setPairingUrl] = useState("");
  const [teamInvite, setTeamInvite] = useState("");
  const [setupError, setSetupError] = useState("");
  const [setupBusy, setSetupBusy] = useState(false);

  useEffect(() => { void readSessionState().then(session => setOwner(session.kind === "loopback" || (session.kind === "session" && session.scopes.includes("admin")))); }, []);

  const runSetup = async (work: () => Promise<void>) => {
    setSetupBusy(true); setSetupError("");
    try { await work(); }
    catch (cause) { setSetupError(cause instanceof Error ? cause.message : "Connection failed"); }
    finally { setSetupBusy(false); }
  };

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const me = await api<{ actorId: string | null; homeId: string; name?: string | null }>("/api/multiplayer/me");
        if (!alive) return;
        setSelfId(me.actorId);
        if (!me.actorId) return;
        const [listed, shared] = await Promise.all([
          api<{ contacts: Contact[] }>("/api/multiplayer/contacts"),
          api<{ rooms: Room[] }>("/api/multiplayer/rooms"),
        ]);
        if (!alive) return;
        setRoster(listed.contacts);
        setContacts(sidebarPeople(listed.contacts, me));
        setRooms(shared.rooms);
        setError("");
      } catch { if (alive) setError("Shared chats unavailable"); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    window.addEventListener("multiplayer:refresh", refresh);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("multiplayer:refresh", refresh); };
  }, []);

  useEffect(() => {
    if (state.activeView !== "shared" || !state.selectedSharedRoomId) return;
    const room = rooms.find(item => item.id === state.selectedSharedRoomId);
    if (!room?.lastActivity || typeof room.unreadCount === "number" || document.visibilityState !== "visible" || !document.hasFocus() || seenRooms[room.id] >= room.lastActivity) return;
    setSeenRooms(previous => {
      const next = { ...previous, [room.id]: room.lastActivity! };
      try { globalThis.localStorage?.setItem("bos.shared-room-seen", JSON.stringify(next)); } catch { /* private browsing */ }
      return next;
    });
  }, [rooms, seenRooms, state.activeView, state.selectedSharedRoomId]);

  if (!selfId && placement !== "unified") return null;
  const openPerson = async (contact: Contact) => {
    if (busyId) return;
    setBusyId(contact.id);
    try {
      const { room } = await api<{ room: Room }>("/api/multiplayer/dm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetId: contact.id }),
      });
      setRooms(previous => previous.some(item => item.id === room.id) ? previous : [...previous, room]);
      dispatch({ type: "selectSharedRoom", roomId: room.id });
      setError("");
    } catch { setError("Could not open chat"); }
    finally { setBusyId(null); }
  };
  const visibleRooms = rooms.filter(room => !(isDirectSharedRoom(room) && room.memberIds.includes(selfId ?? "") && room.memberIds.some(id => roster.some(contact => contact.id === id && contact.kind === "person"))));
  // everyone but me first, so the mark shows who else is here
  const roomFaces = (room: Room) => [...room.memberIds.filter(id => id !== selfId), ...(selfId ? [selfId] : [])]
    .map(id => roster.find(contact => contact.id === id)).filter((contact): contact is Contact => Boolean(contact));
  const roomName = (room: Room) => room.name === "Group chat"
    ? room.memberIds.filter(id => id !== selfId).map(id => roster.find(contact => contact.id === id)?.name).filter(Boolean).join(", ") || room.name
    : room.name;
  const roomUnread = (room: Room) => typeof room.unreadCount === "number"
    ? sharedRoomUnread(room, 0)
    : !(state.activeView === "shared" && state.selectedSharedRoomId === room.id) && sharedRoomUnread(room, seenRooms[room.id] ?? 0);
  const visibleContacts = contacts.filter(contact => contact.id !== selfId && contact.kind === "person");
  const unifiedContacts = visibleContacts;
  if (placement === "unified") {
    const directRoom = (contact: Contact) => rooms.find(room => isDirectSharedRoom(room) && room.memberIds.includes(selfId ?? "") && room.memberIds.includes(contact.id));
    const personEntries: Array<{ id: string; at: number; pinned: boolean; unread: boolean; selected: boolean; element: ReactNode }> = unifiedContacts.map(contact => {
        const room = directRoom(contact);
        const at = room?.lastActivity ?? 0;
        const selected = state.activeView === "shared" && Boolean(room) && state.selectedSharedRoomId === room?.id;
        const unread = Boolean(room && roomUnread(room));
        const avatarPx = 40;
        const rowClass = cn(
          "flex w-full items-center rounded-[10px] text-left outline-none focus-visible:ring-1 focus-visible:ring-hairline disabled:opacity-50",
          compact ? "justify-center px-1 py-1.5" : "gap-2 px-1 py-3",
          selected ? "bg-raised/70" : "hover:bg-raised/40",
        );
        const subtitle = [contact.title?.trim() || "Person", contact.homeName ? `on ${contact.homeName}` : ""].filter(Boolean).join(" · ");
        return { id: `contact:${contact.id}`, at, pinned: pins.includes(`contact:${contact.id}`), unread, selected, element: <div key={contact.id} className="group relative" title={compact ? contact.name : undefined}>
          <button type="button" disabled={busyId !== null} onClick={() => void openPerson(contact)} aria-label={`Chat with ${contact.name}`} className={rowClass}
            onContextMenu={event => openRowMenu(event, at => setRowMenu({ at, label: `${contact.name} actions`, items: [
              { key: "open", label: "Open chat", icon: <MessageCircle size={16} className="text-ink-secondary" />, onSelect: () => void openPerson(contact) },
              pinItem(`contact:${contact.id}`),
              { key: "copy", label: "Copy name", icon: <ClipboardCopy size={16} className="text-ink-secondary" />, onSelect: () => void navigator.clipboard?.writeText(contact.name).catch(() => {}) },
            ] }))}>
            <span className="relative flex shrink-0">
              {contact.avatar ? <PersonPhoto src={contact.avatar} size={avatarPx} />
                : <span style={{ width: avatarPx, height: avatarPx }} className="flex shrink-0 items-center justify-center rounded-full bg-accent/20 text-[13px] font-semibold text-accent">{contact.name.slice(0, 1).toUpperCase()}</span>}
            </span>
            {!compact && <div className="min-w-0 flex-1">
              <div className="sr-only">{subtitle}</div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 grow items-center gap-1.5 truncate text-[14px] font-medium leading-5 text-ink">{pins.includes(`contact:${contact.id}`) && <Pin size={12} className="shrink-0 text-ink-secondary" />}<span className="truncate">{contact.name}</span></span>
              </div>
              <div className="flex items-center gap-2"><span className="min-w-0 truncate text-[13px] leading-5 text-ink-secondary">{room?.preview ?? ""}</span>{unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}</div>
            </div>}
          </button>
        </div> };
      });
    // People sit in their own list under the bots, folded to one row until
    // opened — the same shape as the phone's chat list.
    personEntries.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at || a.id.localeCompare(b.id));
    const peopleUnread = personEntries.filter(entry => entry.unread).length;
    const peopleShown = peopleOpen || personEntries.some(entry => entry.selected);
    const entries: Array<{ id: string; at: number; pinned?: boolean; element: ReactNode }> = [
      ...localRows,
      ...visibleRooms.map(room => ({ id: `room:${room.id}`, at: room.lastActivity ?? 0, pinned: pins.includes(`room:${room.id}`), element: <button key={room.id} type="button" onClick={() => dispatch({ type: "selectSharedRoom", roomId: room.id })}
        onContextMenu={event => openRowMenu(event, at => setRowMenu({ at, label: `${roomName(room)} actions`, items: [
          { key: "open", label: "Open", icon: <MessageCircle size={16} className="text-ink-secondary" />, onSelect: () => dispatch({ type: "selectSharedRoom", roomId: room.id }) },
          pinItem(`room:${room.id}`),
        ] }))}
        aria-label={`Open ${roomName(room)}`} title={roomName(room)} className={cn("flex w-full items-center gap-2 rounded-[10px] px-1 py-3 text-left text-ink hover:bg-raised/40", state.activeView === "shared" && state.selectedSharedRoomId === room.id && "bg-raised/70")}>
        <GroupMark members={roomFaces(room)} size={40} />{!compact && <span className="min-w-0 flex-1"><span className="flex items-center gap-1.5 text-[14px] font-medium leading-5">{pins.includes(`room:${room.id}`) && <Pin size={12} className="shrink-0 text-ink-secondary" />}<span className="truncate">{roomName(room)}</span></span><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink-secondary">{room.preview ?? ""}</span>{roomUnread(room) && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}</span></span>}
      </button> })),
    ];
    entries.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.at - a.at || a.id.localeCompare(b.id));
    return <section aria-label="Chats" className="px-1 pt-1.5">
      {entries.map(entry => <div key={entry.id}>{entry.element}</div>)}
      {personEntries.length > 0 && <>
        {compact
          ? <div aria-hidden="true" className="mx-auto my-2 h-px w-6 bg-hairline/60" />
          : <button type="button" onClick={() => togglePeople(!peopleOpen)} aria-expanded={peopleShown}
              aria-label={`People, ${personEntries.length}${peopleUnread ? `, ${peopleUnread} unread` : ""}`}
              className="mt-3 flex h-9 w-full items-center gap-2 rounded-[10px] px-2 text-left text-ink-secondary outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-hairline">
              <span className="text-[12px] font-semibold uppercase tracking-[0.04em]">People · {personEntries.length}</span>
              {peopleUnread > 0 && !peopleShown && <span className="rounded-full bg-accent px-1.5 text-[11px] font-semibold leading-[18px] text-white tabular-nums">{peopleUnread > 99 ? "99+" : peopleUnread}</span>}
              <ChevronRight size={14} className={cn("ml-auto shrink-0 transition-transform motion-reduce:transition-none", peopleShown && "rotate-90")} />
            </button>}
        {(peopleShown || compact) && personEntries.map(entry => <div key={entry.id}>{entry.element}</div>)}
      </>}

      {rowMenu && <RowContextMenu at={rowMenu.at} label={rowMenu.label} items={rowMenu.items} onClose={closeRowMenu} />}
      {settingUp && owner && !compact && <div className="mb-2 space-y-2 rounded-lg bg-raised p-2 text-xs">
        <p className="font-semibold">Connect a team member</p>
        <p className="text-ink-secondary">Invite once. Both people and their bots then appear in the conversation list.</p>
        <button type="button" disabled={setupBusy} onClick={() => void runSetup(async () => { const result = await api<{ url: string }>("/api/multiplayer/invites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); setTeamInvite(result.url); })}>Create team invite</button>
        {teamInvite && <InviteLink link={teamInvite} />}
        <input aria-label="Team invitation to join" placeholder="Paste invitation from another bos app" value={pairingUrl} onChange={event => setPairingUrl(event.target.value)} className="w-full rounded bg-app p-1" />
        <button type="button" disabled={!pairingUrl.trim() || setupBusy} onClick={() => void runSetup(async () => { await api("/api/multiplayer/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: pairingUrl.trim() }) }); setPairingUrl(""); window.dispatchEvent(new Event("multiplayer:refresh")); })}>Join team</button>
        {setupError && <p role="alert" className="text-danger">{setupError}</p>}
      </div>}
    </section>;
  }
  return <section aria-label="Connected conversations" className="px-1">
    {placement === "people" && !compact && <div className="flex justify-end gap-2 px-2 pb-1">
      {owner && <InviteToggle open={settingUp} onToggle={() => setSettingUp(value => !value)} />}</div>}
    {placement === "people" && settingUp && owner && !compact && <div className="mb-2 space-y-2 rounded-lg bg-raised p-2 text-xs">
      <p className="font-semibold">Connect a team member</p>
      <p className="text-ink-secondary">Invite once. Both people and their bots then appear in the conversation list.</p>
      <button type="button" disabled={setupBusy} onClick={() => void runSetup(async () => {
        const result = await api<{ url: string }>("/api/multiplayer/invites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        setTeamInvite(result.url);
      })} className="rounded bg-accent px-2 py-1 text-accent-ink disabled:opacity-50">Create team invite</button>
      {teamInvite && <InviteLink link={teamInvite} />}
      <input aria-label="Team invitation to join" placeholder="Paste invitation from another bos app" value={pairingUrl} onChange={event => setPairingUrl(event.target.value)} className="w-full rounded bg-app p-1" />
      <button type="button" disabled={!pairingUrl.trim() || setupBusy} onClick={() => void runSetup(async () => {
        await api("/api/multiplayer/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: pairingUrl.trim() }) });
        setPairingUrl(""); window.dispatchEvent(new Event("multiplayer:refresh"));
      })} className="rounded bg-accent px-2 py-1 text-accent-ink disabled:opacity-50">Join team</button>
      {setupError && <p role="alert" className="text-danger">{setupError}</p>}
    </div>}
    {visibleContacts.map(contact => <button key={contact.id} type="button" disabled={busyId !== null}
      onClick={() => void openPerson(contact)} title={contact.name} aria-label={`Chat with ${contact.name}`}
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[14px] text-ink hover:bg-raised/60 disabled:opacity-50">
      {contact.avatar ? <PersonPhoto src={contact.avatar} size={32} />
          : <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/20 font-semibold text-accent">{contact.name.slice(0, 1).toUpperCase()}</span>}
      {!compact && <span className="min-w-0 truncate"><span className="block truncate">{contact.name}</span></span>}
    </button>)}
    {placement === "people" && visibleRooms.map(room => <button key={room.id} type="button" onClick={() => dispatch({ type: "selectSharedRoom", roomId: room.id })}
      aria-label={`Open ${roomName(room)}`} title={roomName(room)}
      className={`flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-[14px] hover:bg-raised/60 ${state.activeView === "shared" && state.selectedSharedRoomId === room.id ? "bg-raised text-ink" : "text-ink-secondary"}`}>
      <GroupMark members={roomFaces(room)} size={40} />{!compact && <span className="min-w-0 flex-1 truncate">{roomName(room)}</span>}{roomUnread(room) && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
    </button>)}
    {error && !compact && <p role="status" className="px-2 pt-1 text-[11px] text-danger">{error}</p>}
  </section>;
}

/** Labelled, so inviting a person isn't hidden behind an unlabelled gear (O7). */
function InviteToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" aria-expanded={open} title="Invite a person and their bots" onClick={onToggle}
    className={cn("ml-2 mt-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium hover:bg-raised", open ? "text-accent" : "text-ink-secondary hover:text-ink")}>
    <UserPlus size={14} />Invite people
  </button>;
}

/** The invite as a link with a Copy button, not a raw URL in a text box. */
export function InviteLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <div className="flex items-center gap-2 rounded bg-app p-1.5">
    <span className="min-w-0 flex-1 truncate text-ink-secondary" title={link}>Invite link ready</span>
    <button type="button" aria-label="Copy invite link" onClick={() => void navigator.clipboard?.writeText(link).then(() => setCopied(true), () => {})}
      className="flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-ink hover:bg-control">
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}{copied ? "Copied" : "Copy link"}
    </button>
  </div>;
}
