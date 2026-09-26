import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, useStore, type Bot, type Message } from "@/state/store";
import type { MausColor } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { ChatView } from "./ChatView";

interface SharedRoom { id: string; homeId: string; name: string; memberIds: string[]; revision?: number; createdBy?: string }
interface SharedAttachment { id: string; name: string; mime: string; size: number }
interface SharedMessage { id: string; sequence: number; sendId: string; actor: { homeId: string; kind: string; localId: string }; text: string; at: number; attachments?: SharedAttachment[]; kind?: "text" | "activity"; tool?: { name: string; ok?: boolean; spoken?: string } }
interface SharedContact { id: string; name: string; kind: "person" | "bot"; title?: string; avatar?: string | null; color?: string; mascotBody?: string | null }

function senderId(message: SharedMessage) { return `${message.actor.homeId}:${message.actor.kind}:${message.actor.localId}`; }

/** Person DMs and group rooms across shared homes. Bots on a linked Mac are
 * relayed by the server as ordinary bots and never come through here. */
export function SharedConversationController({ roomId }: { roomId: string }) {
  const { dispatch } = useStore();
  const [room, setRoom] = useState<SharedRoom | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<SharedContact[]>([]);
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [memberCandidate, setMemberCandidate] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const cursor = useRef(0);
  const uploadedBySend = useRef(new Map<string, SharedAttachment[]>());

  useEffect(() => {
    let alive = true;
    cursor.current = 0;
    uploadedBySend.current.clear();
    setRoom(null);
    setMessages([]);
    void Promise.all([
      api<{ actorId: string | null }>("/api/multiplayer/me"),
      api<{ rooms: SharedRoom[] }>("/api/multiplayer/rooms"),
      api<{ contacts: SharedContact[] }>("/api/multiplayer/contacts"),
    ]).then(([mine, rooms, roster]) => {
      if (!alive) return;
      const selected = rooms.rooms.find(item => item.id === roomId);
      if (!selected) { setError("This conversation is unavailable."); return; }
      setSelfId(mine.actorId);
      setRoom(selected);
      setContacts(roster.contacts);
      setError("");
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : "Could not load conversation."); });
    return () => { alive = false; };
  }, [roomId, loadAttempt]);

  useEffect(() => {
    if (!room) return;
    let alive = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const query = cursor.current === 0 ? "latest=1" : `after=${cursor.current}`;
        const result = await api<{ messages: SharedMessage[] }>(`/api/multiplayer/rooms/${roomId}/messages?${query}&limit=200`);
        if (!alive) return;
        if (result.messages.length) {
          cursor.current = result.messages.at(-1)!.sequence;
          setMessages(previous => [...previous, ...result.messages.filter(item => !previous.some(existing => existing.id === item.id))]);
        }
        setError("");
      } catch (cause) { if (alive) setError(cause instanceof Error ? cause.message : "Conversation is offline."); }
      finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [room, roomId]);

  useEffect(() => {
    let alive = true;
    const refreshRoom = async () => {
      try {
        const result = await api<{ rooms: SharedRoom[] }>("/api/multiplayer/rooms");
        if (!alive) return;
        const current = result.rooms.find(item => item.id === roomId);
        if (current) setRoom(current);
        else dispatch({ type: "showChat" });
      } catch { /* message polling reports connection errors */ }
    };
    const timer = window.setInterval(() => void refreshRoom(), 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [roomId, dispatch]);

  const send = useCallback(async (text: string, files: File[], sendId: string) => {
    let attachments = uploadedBySend.current.get(sendId);
    if (!attachments) {
      attachments = [];
      for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} is larger than 25 MB`);
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
        reader.readAsDataURL(file);
      });
      const result = await api<{ attachment: SharedAttachment }>(`/api/multiplayer/rooms/${roomId}/attachments`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: file.name, mime: file.type || "application/octet-stream", data }),
      });
        attachments.push(result.attachment);
      }
      uploadedBySend.current.set(sendId, attachments);
    }
    await api(`/api/multiplayer/rooms/${roomId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, sendId, attachments }),
    });
    uploadedBySend.current.delete(sendId);
    try {
      const result = await api<{ messages: SharedMessage[] }>(`/api/multiplayer/rooms/${roomId}/messages?after=${cursor.current}&limit=200`);
      if (result.messages.length) {
        cursor.current = result.messages.at(-1)!.sequence;
        setMessages(previous => [...previous, ...result.messages.filter(item => !previous.some(existing => existing.id === item.id))]);
      }
    } catch { /* the room poll will load the accepted send */ }
  }, [roomId]);

  const peerId = room?.memberIds.length === 2 ? room.memberIds.find(id => id !== selfId) : undefined;
  const peer = contacts.find(contact => contact.id === peerId);
  const projected = useMemo<Bot | null>(() => {
    if (!room || !selfId) return null;
    const memberNames = room.memberIds.filter(id => id !== selfId).map(id => contacts.find(contact => contact.id === id)?.name).filter((name): name is string => Boolean(name));
    const display = peer?.name ?? (room.name === "Group chat" && memberNames.length ? memberNames.join(", ") : room.name);
    const latestTool = new Map<string, number>();
    messages.forEach((message, index) => {
      const key = message.kind === "activity" ? message.sendId?.replace(/-(?:start|ok|failed)$/, "") : null;
      if (key?.startsWith("activity-")) latestTool.set(key, index);
    });
    const visible = messages.filter((message, index) => {
      const key = message.kind === "activity" ? message.sendId?.replace(/-(?:start|ok|failed)$/, "") : null;
      return !key?.startsWith("activity-") || latestTool.get(key) === index;
    });
    const history: Message[] = visible.map((message, index) => ({
      id: message.id,
      role: senderId(message) === selfId ? "user" : "bot",
      kind: message.kind ?? "text",
      text: message.text,
      tool: message.tool,
      at: message.at,
      parentId: index > 0 ? visible[index - 1].id : null,
      sharedAttachments: message.attachments,
      from: room.memberIds.length > 2 && senderId(message) !== selfId
        ? { botId: senderId(message), name: contacts.find(contact => contact.id === senderId(message))?.name ?? "Member", color: (contacts.find(contact => contact.id === senderId(message))?.color ?? "blue") as MausColor }
        : undefined,
    }));
    return {
      id: `shared:${room.id}`, threadId: `shared:${room.id}`, name: display,
      title: peer?.title ?? "", description: "", notifications: true,
      color: (peer?.color ?? "blue") as MausColor,
      mascotBody: peer?.mascotBody as MascotBodyId | null,
      avatarUrl: peer?.avatar ?? null,
      unread: false, busy: history.at(-1)?.kind === "activity" && history.at(-1)?.tool?.ok === undefined,
      modelSelection: { instanceId: "shared", model: "shared" },
      messages: history, activeLeafId: history.at(-1)?.id ?? null,
    };
  }, [room, selfId, peer, messages, contacts]);

  const faces = useMemo(() => room && room.memberIds.length > 2
    ? [...room.memberIds.filter(id => id !== selfId), ...(selfId ? [selfId] : [])]
      .map(id => contacts.find(contact => contact.id === id))
      .filter((contact): contact is NonNullable<typeof contact> => Boolean(contact))
      .map(contact => ({ id: contact.id, name: contact.name, kind: contact.kind, avatar: contact.avatar, color: contact.color, mascotBody: contact.mascotBody }))
    : undefined, [room, selfId, contacts]);

  const changeRoom = async (method: "PATCH" | "DELETE" | "POST", suffix: string, patch: Record<string, unknown> = {}) => {
    if (!room) return;
    try {
      const result = await api<{ room?: SharedRoom }>(`/api/multiplayer/rooms/${room.id}${suffix}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: room.revision ?? 1, ...patch }),
      });
      if (result.room) setRoom(result.room);
      else dispatch({ type: "showChat" });
      setError(""); setMenuOpen(false); setEditingName(false);
      window.dispatchEvent(new Event("multiplayer:refresh"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update room."); }
  };

  const actions = room && <div className="relative">
    <button type="button" aria-label="Room options" aria-expanded={menuOpen} onClick={() => setMenuOpen(value => !value)} className="rounded-md px-2 py-1 text-xs text-ink-secondary hover:bg-raised">Room</button>
    {menuOpen && <div className="absolute right-0 top-full z-30 mt-1 w-60 space-y-2 rounded-xl border border-hairline bg-raised p-3 text-xs shadow-lg">
      {editingName ? <form onSubmit={event => { event.preventDefault(); void changeRoom("PATCH", "", { name: draftName }); }} className="flex gap-1">
        <input aria-label="Room name" autoFocus value={draftName} onChange={event => setDraftName(event.target.value)} maxLength={100} className="min-w-0 flex-1 rounded bg-app px-2 py-1 text-ink" />
        <button type="submit" disabled={!draftName.trim()} className="text-accent">Save</button>
      </form> : <button type="button" onClick={() => { setDraftName(room.name); setEditingName(true); }} className="block text-left text-ink">Rename room</button>}
      {room.memberIds.length > 2 && <button type="button" onClick={() => void changeRoom("POST", "/leave")} className="block text-left text-ink">Leave room</button>}
      {room.memberIds.length > 2 && <div className="space-y-1 border-t border-hairline pt-2">
        <span className="text-ink-secondary">Members</span>
        {room.memberIds.filter(id => id !== selfId).map(id => <div key={id} className="flex justify-between gap-2"><span className="truncate">{contacts.find(contact => contact.id === id)?.name ?? id}</span><button type="button" onClick={() => void changeRoom("PATCH", "", { memberIds: room.memberIds.filter(member => member !== id) })} className="text-danger">Remove</button></div>)}
        <div className="flex gap-1"><select aria-label="Add member" value={memberCandidate} onChange={event => setMemberCandidate(event.target.value)} className="min-w-0 flex-1 rounded bg-app text-ink"><option value="">Choose member</option>{contacts.filter(contact => !room.memberIds.includes(contact.id)).map(contact => <option key={contact.id} value={contact.id}>{contact.name}</option>)}</select><button type="button" disabled={!memberCandidate} onClick={() => void changeRoom("PATCH", "", { memberIds: [...room.memberIds, memberCandidate] })} className="text-accent">Add</button></div>
      </div>}
      {(selfId === room.createdBy || selfId === `${room.homeId}:person:owner`) && <button type="button" onClick={() => { if (window.confirm(`Delete ${room.name} for everyone?`)) void changeRoom("DELETE", ""); }} className="block border-t border-hairline pt-2 text-left text-danger">Delete for everyone</button>}
    </div>}
  </div>;

  if (!projected) return <main className="flex flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary">{error || "Loading conversation…"}{error && <button type="button" onClick={() => setLoadAttempt(value => value + 1)} className="rounded-lg bg-raised px-3 py-2 text-ink">Retry</button>}</main>;
  return <><ChatView bot={projected} shared={{ send, faces, actions }} />{error && <div role="alert" className="absolute bottom-24 left-1/2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}</>;
}
