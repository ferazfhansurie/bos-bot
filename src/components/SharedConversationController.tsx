import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRight } from "lucide-react";
import { api, useStore, type Bot, type Message } from "@/state/store";
import type { MausColor } from "@/lib/mascot";
import type { MascotBodyId } from "../../shared/mascot-bodies";
import { ChatView } from "./ChatView";
import { SharedConversationDetails } from "./SharedConversationDetails";
import { sharedVisibleMessages, sharedReplyReference, sharedActivityLabel, sharedHasActiveWork } from "./shared-conversation";
import { emptySharedHistory, mergeSharedHistory, sharedReadSequenceToSave, sharedAttachmentError, isDirectSharedRoom, sharedBotTargets, sharedMentionBots, type SharedRoom, type SharedContact, type SharedEligibleBot, type SharedAttachment, type SharedFile, type SharedMessage, type SharedHistoryPage, type SharedPreferences, type SharedNotifications } from "./shared-conversation";
function senderId(message: SharedMessage) { return `${message.actor.homeId}:${message.actor.kind}:${message.actor.localId}`; }
function errorText(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }

/** Shared human conversations use the normal transcript and composer. */
export function SharedConversationController({ roomId }: { roomId: string }) {
  const { dispatch } = useStore();
  const [room, setRoom] = useState<SharedRoom | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [contacts, setContacts] = useState<SharedContact[]>([]);
  const [eligibleBots, setEligibleBots] = useState<SharedEligibleBot[]>([]);
  const [history, setHistory] = useState(emptySharedHistory);
  const historyRef = useRef(history);
  const { messages, hasMore } = history;
  const applyHistory = useCallback((page: SharedHistoryPage, source: "latest" | "after" | "before" | "mutation") => {
    const next = mergeSharedHistory(historyRef.current, page, source);
    historyRef.current = next;
    setHistory(next);
  }, []);
  const [preferences, setPreferences] = useState<SharedPreferences | null>(null);
  const [preferencePending, setPreferencePending] = useState(false);
  const [preferenceError, setPreferenceError] = useState("");
  const readPending = useRef(false);
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [olderError, setOlderError] = useState("");
  const [botsError, setBotsError] = useState("");
  const [changeError, setChangeError] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [changing, setChanging] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [olderLoading, setOlderLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const uploadedBySend = useRef(new Map<string, SharedAttachment[]>());
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const mentionBots = useMemo(() => sharedMentionBots(eligibleBots), [eligibleBots]);

  useEffect(() => {
    let alive = true;
    historyRef.current = emptySharedHistory(); setHistory(historyRef.current);
    uploadedBySend.current.clear();
    setRoom(null); setEligibleBots([]); setError(""); setHistoryError(""); setOlderError("");
    setHistoryLoading(true); setPreferences(null);
    void Promise.all([
      api<{ actorId: string | null }>("/api/multiplayer/me"),
      api<{ rooms: SharedRoom[] }>("/api/multiplayer/rooms"),
      api<{ contacts: SharedContact[] }>("/api/multiplayer/contacts"),
    ]).then(([mine, rooms, roster]) => {
      if (!alive) return;
      const selected = rooms.rooms.find(item => item.id === roomId);
      if (!selected || !mine.actorId) { setError("This conversation is unavailable."); return; }
      setSelfId(mine.actorId); setRoom(selected); setContacts(roster.contacts);
    }).catch(cause => { if (alive) setError(errorText(cause, "Could not load conversation.")); });
    return () => { alive = false; };
  }, [roomId, loadAttempt]);

  const ready = room !== null;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const load = async () => {
      try {
        const result = await api<SharedPreferences>(`/api/multiplayer/rooms/${roomId}/preferences`);
        if (alive) { preferencesRef.current = result; setPreferences(result); setPreferenceError(""); }
      } catch (cause) { if (alive) setPreferenceError(errorText(cause, "Could not load notification settings.")); }
    };
    void load();
    return () => { alive = false; };
  }, [ready, roomId, loadAttempt]);

  const markRead = useCallback(async () => {
    const saved = preferencesRef.current;
    if (!ready || !saved || readPending.current || !mounted.current) return;
    const readSequence = sharedReadSequenceToSave(historyRef.current.sequence, saved.readSequence, document.visibilityState === "visible", document.hasFocus());
    if (readSequence === null) return;
    readPending.current = true;
    try {
      const result = await api<SharedPreferences>(`/api/multiplayer/rooms/${roomId}/preferences`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ readSequence }),
      });
      if (!mounted.current) return;
      setPreferences(previous => {
        const next = { ...(previous ?? saved), readSequence: Math.max(previous?.readSequence ?? 0, result.readSequence) };
        preferencesRef.current = next;
        return next;
      });
      window.dispatchEvent(new Event("multiplayer:refresh"));
    } catch { /* Preserve unread state and retry while the conversation is foreground. */ }
    finally { readPending.current = false; }
  }, [ready, roomId]);
  useEffect(() => { void markRead(); }, [markRead, history.sequence, preferences?.readSequence]);
  useEffect(() => {
    const refreshRead = () => void markRead();
    window.addEventListener("focus", refreshRead);
    document.addEventListener("visibilitychange", refreshRead);
    const timer = window.setInterval(refreshRead, 5000);
    return () => { window.removeEventListener("focus", refreshRead); document.removeEventListener("visibilitychange", refreshRead); window.clearInterval(timer); };
  }, [markRead]);

  const changeNotifications = async (notifications: SharedNotifications) => {
    if (preferencePending) return;
    setPreferencePending(true); setPreferenceError("");
    try {
      const result = await api<SharedPreferences>(`/api/multiplayer/rooms/${roomId}/preferences`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ notifications }),
      });
      if (!mounted.current) return;
      setPreferences(previous => {
        const next = { notifications: result.notifications, readSequence: Math.max(previous?.readSequence ?? 0, result.readSequence) };
        preferencesRef.current = next;
        return next;
      });
      window.dispatchEvent(new Event("multiplayer:refresh"));
    } catch (cause) { if (mounted.current) setPreferenceError(errorText(cause, "Could not save notification settings.")); }
    finally { if (mounted.current) setPreferencePending(false); }
  };

  const changeMessage = useCallback(async (id: string, text: string | null) => {
    const message = historyRef.current.messages.find(item => item.id === id);
    if (!message || senderId(message) !== selfId || message.deletedAt) throw new Error("This message cannot be changed.");
    const result = await api<{ message: SharedMessage }>(`/api/multiplayer/rooms/${roomId}/messages/${id}`, {
      method: text === null ? "DELETE" : "PATCH", headers: { "content-type": "application/json" },
      ...(text === null ? {} : { body: JSON.stringify({ text }) }),
    });
    if (!mounted.current) return;
    applyHistory({ messages: [result.message] }, "mutation");
    window.dispatchEvent(new Event("multiplayer:refresh"));
  }, [roomId, selfId, applyHistory]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    let busy = false;
    let first = true;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const result = await api<SharedHistoryPage>(`/api/multiplayer/rooms/${roomId}/messages?${first ? "latest=1" : `after=${historyRef.current.sequence}&version=${historyRef.current.version}`}&limit=200`);
        if (!alive) return;
        applyHistory(result, first ? "latest" : "after");
        first = false;
        setHistoryLoading(false); setHistoryError("");
      } catch (cause) { if (alive) { setHistoryLoading(false); setHistoryError(errorText(cause, "Conversation is offline.")); } }
      finally { busy = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    window.addEventListener("multiplayer:retry-history", refresh);
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener("multiplayer:retry-history", refresh); };
  }, [ready, roomId, loadAttempt, applyHistory]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const refresh = async () => {
      const results = await Promise.allSettled([
        api<{ rooms: SharedRoom[] }>("/api/multiplayer/rooms"),
        api<{ bots: SharedEligibleBot[] }>(`/api/multiplayer/rooms/${roomId}/bots`),
        api<{ contacts: SharedContact[] }>("/api/multiplayer/contacts"),
      ]);
      if (!alive) return;
      const [rooms, bots, roster] = results;
      if (rooms.status === "fulfilled") {
        const current = rooms.value.rooms.find(item => item.id === roomId);
        if (current) setRoom(previous => previous && (previous.revision ?? 1) > (current.revision ?? 1) ? previous : current);
        else { setError("You no longer have access to this conversation."); setRoom(null); }
      }
      if (bots.status === "fulfilled") { setEligibleBots(bots.value.bots); setBotsError(""); }
      else { setEligibleBots([]); setBotsError("Bot mentions are unavailable. Retrying…"); }
      if (roster.status === "fulfilled") setContacts(roster.value.contacts);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [ready, roomId]);

  const loadOlder = useCallback(async () => {
    const before = messages[0]?.sequence;
    if (!before || olderLoading || !hasMore) return;
    setOlderLoading(true); setOlderError("");
    try {
      const result = await api<SharedHistoryPage>(`/api/multiplayer/rooms/${roomId}/messages?before=${before}&limit=200`);
      if (!mounted.current) return;
      applyHistory(result, "before");
      setOlderError("");
    } catch (cause) { if (mounted.current) setOlderError(errorText(cause, "Could not load earlier messages.")); }
    finally { if (mounted.current) setOlderLoading(false); }
  }, [roomId, messages, olderLoading, hasMore, applyHistory]);

  const showFileMessage = async (file: Pick<SharedFile, "messageId" | "sequence">) => {
    if (olderLoading) throw new Error("Earlier messages are still loading. Try again in a moment.");
    setOlderLoading(true);
    try {
      for (let page = 0; page < 20 && file.sequence > historyRef.current.sequence; page++) {
        const after = historyRef.current.sequence;
        const result = await api<SharedHistoryPage>(`/api/multiplayer/rooms/${roomId}/messages?after=${after}&version=${historyRef.current.version}&limit=200`);
        if (!mounted.current) return;
        applyHistory(result, "after");
        if (historyRef.current.sequence <= after) break;
      }
      // Keep history contiguous: inserting a single old message would skip the
      // intervening pages on the next normal scroll-back.
      for (let page = 0; page < 20 && !historyRef.current.messages.some(message => message.id === file.messageId); page++) {
        const before = historyRef.current.messages[0]?.sequence;
        if (!before || !historyRef.current.hasMore || before <= file.sequence) break;
        const result = await api<SharedHistoryPage>(`/api/multiplayer/rooms/${roomId}/messages?before=${before}&limit=200`);
        if (!mounted.current) return;
        applyHistory(result, "before");
        if ((historyRef.current.messages[0]?.sequence ?? before) >= before) break;
      }
      if (!historyRef.current.messages.some(message => message.id === file.messageId)) throw new Error(historyRef.current.hasMore ? "This message is further back. Tap Show message again to continue loading." : "This message is no longer available.");
      setDetailsOpen(false);
      dispatch({ type: "focusMessage", threadId: `shared:${roomId}`, messageId: file.messageId });
    } finally { if (mounted.current) setOlderLoading(false); }
  };

  const send = useCallback(async (text: string, files: File[], sendId: string, options?: { replyTo?: string }) => {
    const problem = files.map(sharedAttachmentError).find(Boolean);
    if (problem) throw new Error(problem);
    let attachments = uploadedBySend.current.get(sendId);
    if (!attachments) {
      attachments = [];
      for (const file of files) {
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
    const botTargets = sharedBotTargets(text, mentionBots);
    await api(`/api/multiplayer/rooms/${roomId}/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sendId, attachments, ...(options?.replyTo ? { replyTo: options.replyTo } : {}), ...(botTargets.length ? { botTargets } : {}) }),
    });
    uploadedBySend.current.delete(sendId);
    try {
      const result = await api<SharedHistoryPage>(`/api/multiplayer/rooms/${roomId}/messages?after=${historyRef.current.sequence}&version=${historyRef.current.version}&limit=200`);
      if (!mounted.current) return;
      applyHistory(result, "after");
    } catch { /* the poll will load the accepted send without replaying it */ }
  }, [roomId, mentionBots, applyHistory]);

  const direct = room ? isDirectSharedRoom(room) : false;
  const peerId = direct ? room?.memberIds.find(id => id !== selfId) : undefined;
  const peer = contacts.find(contact => contact.id === peerId);
  const projected = useMemo<Bot | null>(() => {
    if (!room || !selfId) return null;
    const memberNames = room.memberIds.filter(id => id !== selfId).map(id => contacts.find(contact => contact.id === id)?.name).filter((name): name is string => Boolean(name));
    const display = peer?.name ?? (room.name === "Group chat" && memberNames.length ? memberNames.join(", ") : room.name);
    const visible = sharedVisibleMessages(messages);
    const history: Message[] = visible.map((message, index) => {
      const actorId = senderId(message);
      const actor = contacts.find(contact => contact.id === actorId);
      const actorBot = eligibleBots.find(bot => bot.id === actorId);
      return {
        id: message.id, role: actorId === selfId ? "user" : "bot", kind: message.kind ?? "text",
        text: message.deletedAt ? "Message removed" : message.text,
        tool: message.tool ? { ...message.tool, spoken: sharedActivityLabel(message) } : undefined, at: message.at,
        parentId: index > 0 ? visible[index - 1].id : null,
        replyToId: sharedReplyReference(message),
        sharedAttachments: message.deletedAt ? undefined : message.attachments,
        from: actorId !== selfId ? {
          botId: actorId,
          name: actorBot ? `${actorBot.name} · ${actorBot.ownerName}` : actor?.name ?? (message.actor.kind === "bot" ? "Bot" : "Member"),
          color: (actor?.color ?? actorBot?.color ?? "blue") as MausColor,
        } : undefined,
      };
    });
    return {
      id: `shared:${room.id}`, threadId: `shared:${room.id}`, name: display,
      title: peer?.title ?? "", description: "", notifications: true,
      color: (peer?.color ?? "blue") as MausColor, mascotBody: peer?.mascotBody as MascotBodyId | null,
      avatarUrl: peer?.avatar ?? null, unread: false,
      busy: sharedHasActiveWork(messages),
      modelSelection: { instanceId: "shared", model: "shared" },
      messages: history, activeLeafId: history.at(-1)?.id ?? null, hasMore,
    };
  }, [room, selfId, peer, messages, contacts, eligibleBots, hasMore]);
  const faces = useMemo(() => room
    ? (direct ? room.memberIds.filter(id => id !== selfId) : [...room.memberIds.filter(id => id !== selfId), ...(selfId ? [selfId] : [])])
      .map(id => contacts.find(contact => contact.id === id) ?? { id, name: id === selfId ? "You" : "Member", kind: "person" as const })
    : [], [room, direct, selfId, contacts]);

  const changeRoom = async (method: "PATCH" | "DELETE" | "POST", suffix: string, patch: Record<string, unknown> = {}) => {
    if (!room || changing) return false;
    setChanging(true); setChangeError("");
    try {
      const result = await api<{ room?: SharedRoom }>(`/api/multiplayer/rooms/${room.id}${suffix}`, {
        method, headers: { "content-type": "application/json" }, body: JSON.stringify({ revision: room.revision ?? 1, ...patch }),
      });
      if (result.room) setRoom(result.room);
      else dispatch({ type: "showChat" });
      window.dispatchEvent(new Event("multiplayer:refresh"));
      return true;
    } catch (cause) { setChangeError(errorText(cause, "Could not update conversation.")); return false; }
    finally { if (mounted.current) setChanging(false); }
  };

  if (!projected || !room || !selfId) return <main className="flex flex-1 flex-col items-center justify-center gap-3 bg-app text-ink-secondary"><p role={error ? "alert" : "status"}>{error || "Loading conversation…"}</p>{error && <button type="button" onClick={() => setLoadAttempt(value => value + 1)} className="rounded-lg bg-raised px-3 py-2 text-ink">Retry</button>}</main>;
  const banner = <>{historyLoading && <p role="status" className="px-4 py-2 text-center text-xs text-ink-secondary">Loading messages…</p>}{historyError && <div role="alert" className="flex items-center justify-center gap-3 bg-danger/10 px-4 py-2 text-xs text-danger">{historyError}<button type="button" onClick={() => window.dispatchEvent(new Event("multiplayer:retry-history"))} className="underline">Retry</button></div>}{olderError && <div role="alert" className="flex items-center justify-center gap-3 bg-danger/10 px-4 py-2 text-xs text-danger">{olderError}<button type="button" disabled={olderLoading} onClick={() => void loadOlder()} className="underline">Retry earlier messages</button></div>}{botsError && <p role="status" className="px-4 py-1 text-center text-xs text-ink-secondary">{botsError}</p>}</>;
  return <>
    <ChatView bot={projected} shared={{ send, faces, mentionBots, onOpenDetails: () => setDetailsOpen(true), onOpenSearch: () => { setDetailsOpen(true); setSearchFocus(value => value + 1); }, banner,
      editMessage: (id, text) => changeMessage(id, text), deleteMessage: id => changeMessage(id, null),
      messageMeta: Object.fromEntries(messages.map(message => [message.id, { editedAt: message.editedAt, deletedAt: message.deletedAt }])),
      changeRevision: history.changeRevision,
      loadOlder, olderLoading, historyLoading,
      actions: <button type="button" aria-label="Conversation details" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(value => !value)} className="rounded-md p-1.5 text-ink-secondary hover:bg-raised hover:text-ink"><PanelRight size={18} /></button>,
    }} />
    {detailsOpen && <SharedConversationDetails eligibleBots={eligibleBots} searchFocus={searchFocus} room={room} selfId={selfId} contacts={contacts} title={projected.name} pending={changing} error={changeError} onClose={() => setDetailsOpen(false)} onChange={changeRoom}
      preferences={preferences} preferencePending={preferencePending} preferenceError={preferenceError} onNotificationsChange={changeNotifications} onShowMessage={showFileMessage} />}
  </>;
}
