import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import { api, formatTime, useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { useShowThreads } from "@/lib/thread-preferences";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import type { ReactNode } from "react";
import { readSessionState } from "@/lib/session";
import { GroupMark, PersonPhoto } from "./Avatar";
import { isDirectSharedRoom, sharedRoomUnread } from "./shared-conversation";

interface Contact { id: string; name: string; kind: "person" | "bot"; homeId?: string; homeName?: string; title?: string; avatar?: string | null; color?: string | null; mascotBody?: string | null }
interface Room { id: string; name: string; kind?: "direct" | "group"; memberIds: string[]; lastActivity?: number; preview?: string; unreadCount?: number; readSequence?: number; notifications?: "all" | "mentions" | "muted" }
export interface LocalConversationRow { id: string; at: number; element: ReactNode }

/** Remote people and person rooms share the conversation list with local bots.
 * Bots on a linked Mac arrive through the bot list itself, never here. */
export function SharedContactsSidebar({ compact = false, placement = "people", localRows = [], density = "comfortable" }: { compact?: boolean; placement?: "people" | "unified"; localRows?: LocalConversationRow[]; density?: SidebarDensity }) {
  const { state, dispatch } = useStore();
  const showThreads = useShowThreads();
  const [selfId, setSelfId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [seenRooms, setSeenRooms] = useState<Record<string, number>>(() => {
    try { return JSON.parse(globalThis.localStorage?.getItem("bos.shared-room-seen") ?? "{}"); }
    catch { return {}; }
  });
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
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
        const me = await api<{ actorId: string | null; homeId: string }>("/api/multiplayer/me");
        if (!alive) return;
        setSelfId(me.actorId);
        if (!me.actorId) return;
        const [roster, shared] = await Promise.all([
          api<{ contacts: Contact[] }>("/api/multiplayer/contacts"),
          api<{ rooms: Room[] }>("/api/multiplayer/rooms"),
        ]);
        if (!alive) return;
        setContacts(roster.contacts.filter(contact => contact.id !== me.actorId && contact.kind === "person"));
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
  const visibleRooms = rooms.filter(room => !(isDirectSharedRoom(room) && room.memberIds.includes(selfId ?? "") && room.memberIds.some(id => contacts.some(contact => contact.id === id))));
  // everyone but me first, so the mark shows who else is here
  const roomFaces = (room: Room) => [...room.memberIds.filter(id => id !== selfId), ...(selfId ? [selfId] : [])]
    .map(id => contacts.find(contact => contact.id === id)).filter((contact): contact is Contact => Boolean(contact));
  const roomName = (room: Room) => room.name === "Group chat"
    ? room.memberIds.filter(id => id !== selfId).map(id => contacts.find(contact => contact.id === id)?.name).filter(Boolean).join(", ") || room.name
    : room.name;
  const roomUnread = (room: Room) => typeof room.unreadCount === "number"
    ? sharedRoomUnread(room, 0)
    : !(state.activeView === "shared" && state.selectedSharedRoomId === room.id) && sharedRoomUnread(room, seenRooms[room.id] ?? 0);
  const visibleContacts = contacts.filter(contact => contact.id !== selfId && contact.kind === "person");
  const unifiedContacts = visibleContacts;
  if (placement === "unified") {
    const directRoom = (contact: Contact) => rooms.find(room => isDirectSharedRoom(room) && room.memberIds.includes(selfId ?? "") && room.memberIds.includes(contact.id));
    const entries: Array<{ id: string; at: number; element: ReactNode }> = [
      ...localRows,
      ...unifiedContacts.map(contact => {
        const room = directRoom(contact);
        const at = room?.lastActivity ?? 0;
        const selected = state.activeView === "shared" && Boolean(room) && state.selectedSharedRoomId === room?.id;
        const unread = Boolean(room && roomUnread(room));
        const avatarPx = compact ? 44 : density === "compact" ? (showThreads ? 26 : 40) : (showThreads ? 32 : 56);
        const rowClass = cn(
          "flex w-full items-center rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:opacity-50",
          compact ? "justify-center px-1 py-1.5"
            : density === "compact" ? cn(showThreads ? "gap-1.5 py-1 pl-6 pr-9" : "gap-2 py-1.5 pl-2 pr-9")
              : cn(showThreads ? "gap-2 py-2 pl-6 pr-9" : "gap-3 py-2.5 pl-2 pr-9"),
          selected ? "bg-raised/70" : "hover:bg-raised/40",
        );
        const subtitle = [contact.title?.trim() || "Person", contact.homeName ? `on ${contact.homeName}` : ""].filter(Boolean).join(" · ");
        return { id: `contact:${contact.id}`, at, element: <div key={contact.id} className="group relative" title={compact ? contact.name : undefined}>
          <button type="button" disabled={busyId !== null} onClick={() => void openPerson(contact)} aria-label={`Chat with ${contact.name}`} className={rowClass}>
            <span className="relative flex shrink-0">
              {contact.avatar ? <PersonPhoto src={contact.avatar} size={avatarPx} />
                : <span style={{ width: avatarPx, height: avatarPx }} className="flex shrink-0 items-center justify-center rounded-full bg-accent/20 text-[13px] font-semibold text-accent">{contact.name.slice(0, 1).toUpperCase()}</span>}
            </span>
            {!compact && <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] font-medium leading-4 text-ink-secondary">{subtitle}</div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 grow truncate text-[14px] font-semibold text-ink">{contact.name}</span>
                {selected && at > 0 && <span className="shrink-0 text-xs text-ink-secondary">{formatTime(at)}</span>}
              </div>
              <div className="flex items-center gap-2"><span className="min-w-0 truncate text-[11px] text-ink-secondary">{room?.preview ?? ""}</span>{unread && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}</div>
            </div>}
          </button>
        </div> };
      }),
      ...visibleRooms.map(room => ({ id: `room:${room.id}`, at: room.lastActivity ?? 0, element: <button key={room.id} type="button" onClick={() => dispatch({ type: "selectSharedRoom", roomId: room.id })}
        aria-label={`Open ${roomName(room)}`} title={roomName(room)} className={cn("flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left text-ink hover:bg-raised/40", state.activeView === "shared" && state.selectedSharedRoomId === room.id && "bg-raised/70")}>
        <GroupMark members={roomFaces(room)} size={compact ? 44 : 48} />{!compact && <span className="min-w-0 flex-1"><span className="flex justify-between gap-2 text-[14px] font-semibold"><span className="truncate">{roomName(room)}</span>{(room.lastActivity ?? 0) > 0 && <span className="shrink-0 text-xs font-normal text-ink-secondary">{formatTime(room.lastActivity!)}</span>}</span><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[11px] text-ink-secondary">{room.preview ?? ""}</span>{roomUnread(room) && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}</span></span>}
      </button> })),
    ];
    entries.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    return <section aria-label="Chats" className="px-1">{!compact && <div className="px-2 pb-1 text-[12px] font-semibold text-ink-secondary">Chats</div>}
      {entries.map(entry => <div key={entry.id}>{entry.element}</div>)}
      {owner && !compact && <button type="button" title="Connect people and workspaces" aria-label="Connect people and workspaces" onClick={() => setSettingUp(value => !value)} className="ml-2 mt-1 text-ink-secondary"><Settings2 size={16} /></button>}
      {settingUp && owner && !compact && <div className="mb-2 space-y-2 rounded-lg bg-raised p-2 text-xs">
        <p className="font-semibold">Connect a team member</p>
        <button type="button" disabled={setupBusy} onClick={() => void runSetup(async () => { const result = await api<{ url: string }>("/api/multiplayer/invites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }); setTeamInvite(result.url); })}>Create team invite</button>
        {teamInvite && <input readOnly aria-label="Team invitation" value={teamInvite} onFocus={event => event.currentTarget.select()} className="w-full rounded bg-app p-1" />}
        <input aria-label="Team invitation to join" placeholder="Paste invitation from another bos app" value={pairingUrl} onChange={event => setPairingUrl(event.target.value)} className="w-full rounded bg-app p-1" />
        <button type="button" disabled={!pairingUrl.trim() || setupBusy} onClick={() => void runSetup(async () => { await api("/api/multiplayer/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: pairingUrl.trim() }) }); setPairingUrl(""); window.dispatchEvent(new Event("multiplayer:refresh")); })}>Join team</button>
        {setupError && <p role="alert" className="text-danger">{setupError}</p>}
      </div>}
    </section>;
  }
  return <section aria-label="Connected conversations" className="px-1">
    {placement === "people" && !compact && <div className="flex justify-end gap-2 px-2 pb-1">
      {owner && <button type="button" title="Connect people and workspaces" aria-label="Connect people and workspaces" onClick={() => setSettingUp(value => !value)}><Settings2 size={16} /></button>}</div>}
    {placement === "people" && settingUp && owner && !compact && <div className="mb-2 space-y-2 rounded-lg bg-raised p-2 text-xs">
      <p className="font-semibold">Connect a team member</p>
      <p className="text-ink-secondary">Invite once. Both people and their bots then appear in the conversation list.</p>
      <button type="button" disabled={setupBusy} onClick={() => void runSetup(async () => {
        const result = await api<{ url: string }>("/api/multiplayer/invites", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        setTeamInvite(result.url);
      })} className="rounded bg-accent px-2 py-1 text-accent-ink disabled:opacity-50">Create team invite</button>
      {teamInvite && <input readOnly aria-label="Team invitation" value={teamInvite} onFocus={event => event.currentTarget.select()} className="w-full rounded bg-app p-1" />}
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
      <GroupMark members={roomFaces(room)} size={32} />{!compact && <span className="min-w-0 flex-1 truncate">{roomName(room)}</span>}{roomUnread(room) && <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
    </button>)}
    {error && !compact && <p role="status" className="px-2 pt-1 text-[11px] text-danger">{error}</p>}
  </section>;
}
