import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Bot, type Message } from "@/state/store";
import type { MausColor } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { ChatView } from "./ChatView";

interface SharedRoom { id: string; name: string; memberIds: string[] }
interface SharedAttachment { id: string; name: string; mime: string; size: number }
interface SharedMessage { id: string; sequence: number; actor: { homeId: string; kind: string; localId: string }; text: string; at: number; attachments?: SharedAttachment[]; kind?: "text" | "activity"; tool?: { name: string; ok?: boolean; spoken?: string } }
interface SharedContact { id: string; name: string; kind: "person" | "bot"; title?: string; avatar?: string | null; color?: string; mascotBody?: string | null }

function senderId(message: SharedMessage) { return `${message.actor.homeId}:${message.actor.kind}:${message.actor.localId}`; }

/** Person DMs and group rooms across shared homes. Bots on a linked Mac are
 * relayed by the server as ordinary bots and never come through here. */
export function SharedConversationController({ roomId }: { roomId: string }) {
  const [room, setRoom] = useState<SharedRoom | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<SharedContact[]>([]);
  const [messages, setMessages] = useState<SharedMessage[]>([]);
  const [error, setError] = useState("");
  const cursor = useRef(0);
  const uploadedBySend = useRef(new Map<string, SharedAttachment[]>());

  useEffect(() => {
    let alive = true;
    cursor.current = 0;
    uploadedBySend.current.clear();
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
  }, [roomId]);

  useEffect(() => {
    if (!room) return;
    let alive = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api<{ messages: SharedMessage[] }>(`/api/multiplayer/rooms/${roomId}/messages?after=${cursor.current}&limit=200`);
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
    const result = await api<{ messages: SharedMessage[] }>(`/api/multiplayer/rooms/${roomId}/messages?after=${cursor.current}&limit=200`);
    if (result.messages.length) {
      cursor.current = result.messages.at(-1)!.sequence;
      setMessages(previous => [...previous, ...result.messages.filter(item => !previous.some(existing => existing.id === item.id))]);
    }
    uploadedBySend.current.delete(sendId);
  }, [roomId]);

  const peerId = room?.memberIds.length === 2 ? room.memberIds.find(id => id !== selfId) : undefined;
  const peer = contacts.find(contact => contact.id === peerId);
  const projected = useMemo<Bot | null>(() => {
    if (!room || !selfId) return null;
    const display = peer?.name ?? room.name;
    const history: Message[] = messages.map((message, index) => ({
      id: message.id,
      role: senderId(message) === selfId ? "user" : "bot",
      kind: message.kind ?? "text",
      text: message.text,
      tool: message.tool,
      at: message.at,
      parentId: index > 0 ? messages[index - 1].id : null,
      sharedAttachments: message.attachments,
      from: room.memberIds.length > 2 && senderId(message) !== selfId
        ? { botId: senderId(message), name: contacts.find(contact => contact.id === senderId(message))?.name ?? "Member", color: "blue" }
        : undefined,
    }));
    return {
      id: `shared:${room.id}`, threadId: `shared:${room.id}`, name: display,
      title: peer?.title ?? "", description: "", notifications: true,
      color: (peer?.color ?? "blue") as MausColor,
      mascotBody: peer?.mascotBody as MascotBodyId | null,
      avatarUrl: peer?.avatar ?? null,
      unread: false, busy: false, modelSelection: { instanceId: "shared", model: "shared" },
      messages: history, activeLeafId: history.at(-1)?.id ?? null,
    };
  }, [room, selfId, peer, messages, contacts]);

  const faces = useMemo(() => room && room.memberIds.length > 2
    ? [...room.memberIds.filter(id => id !== selfId), ...(selfId ? [selfId] : [])]
      .map(id => contacts.find(contact => contact.id === id))
      .filter((contact): contact is NonNullable<typeof contact> => Boolean(contact))
      .map(contact => ({ id: contact.id, name: contact.name, kind: contact.kind, avatar: contact.avatar, color: contact.color, mascotBody: contact.mascotBody }))
    : undefined, [room, selfId, contacts]);

  if (!projected) return <main className="flex flex-1 items-center justify-center bg-app text-ink-secondary">{error || "Loading conversation…"}</main>;
  return <><ChatView bot={projected} shared={{ send, faces }} />{error && <div role="alert" className="absolute bottom-24 left-1/2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">{error}</div>}</>;
}
