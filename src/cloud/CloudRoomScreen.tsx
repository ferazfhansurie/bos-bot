// Minimal slice 1 room screen: test sign-in, workspace/room/invite setup and
// one room thread with its outbox. Fictional data against a local server only.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cloudApi, signInWithTestIssuer, type CloudApi, type CloudSession, type SyncWorkspace } from "./api";
import { CloudRoomController, type CloudRoomRef } from "./controller";
import { outboxLabel } from "./outbox";
import { isRead } from "./read-coverage";
import { timeline } from "./room-reducer";

const field = "rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";
const button = "rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function failureText(result: { ok: false; failure: { error: string } | { transport: true } }): string {
  return "error" in result.failure ? result.failure.error : "couldn't reach the server";
}

export function CloudRoomScreen({ baseUrl }: { baseUrl: string }) {
  const [session, setSession] = useState<CloudSession | null>(null);
  const [subject, setSubject] = useState("");
  const [error, setError] = useState<string | null>(null);

  if (!session) {
    return (
      <form
        className="flex max-w-sm flex-col gap-2 p-6"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await signInWithTestIssuer(baseUrl, subject.trim());
          if (result.ok) setSession(result.value);
          else setError(failureText(result));
        }}
      >
        <label className="text-sm">test sign-in subject</label>
        <input className={field} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="alice" />
        <button className={button} disabled={!subject.trim()}>sign in</button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    );
  }
  return <SignedIn session={session} onSignOut={() => setSession(null)} />;
}

function SignedIn({ session, onSignOut }: { session: CloudSession; onSignOut: () => void }) {
  const api = useMemo(() => cloudApi(session), [session]);
  const [workspaces, setWorkspaces] = useState<SyncWorkspace[]>([]);
  const [room, setRoom] = useState<CloudRoomRef | null>(null);
  const [name, setName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async () => {
    const result = await api.sync();
    if (!result.ok) return setNotice(failureText(result));
    setWorkspaces(result.value.workspaces);
    // Discovery is the full authorized set; a room that vanished closes.
    setRoom((current) =>
      current && result.value.workspaces.some((w) => w.workspace_id === current.workspace_id && w.rooms.some((r) => r.room_id === current.room_id)) ? current : null,
    );
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const act = async (run: () => Promise<{ ok: true } | { ok: false; failure: { error: string } | { transport: true } }>, done?: string) => {
    const result = await run();
    setNotice(result.ok ? (done ?? null) : failureText(result));
    await refresh();
  };

  return (
    <div className="flex h-screen text-sm">
      <aside className="flex w-72 flex-col gap-3 overflow-y-auto border-r border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <span>{session.subject}</span>
          <button className={button} onClick={onSignOut}>sign out</button>
        </div>
        <div className="flex gap-1">
          <input className={`${field} min-w-0 flex-1`} value={name} onChange={(event) => setName(event.target.value)} placeholder="workspace name" />
          <button className={button} disabled={!name.trim()} onClick={() => void act(() => api.createWorkspace(name.trim())).then(() => setName(""))}>create</button>
        </div>
        <div className="flex gap-1">
          <input className={`${field} min-w-0 flex-1`} value={inviteToken} onChange={(event) => setInviteToken(event.target.value)} placeholder="invite token" />
          <button className={button} disabled={!inviteToken.trim()} onClick={() => void act(() => api.redeemInvite(inviteToken.trim()), "joined").then(() => setInviteToken(""))}>join</button>
        </div>
        {workspaces.map((workspace) => (
          <WorkspaceItem key={workspace.workspace_id} api={api} workspace={workspace} selected={room} onSelect={setRoom} act={act} onNotice={setNotice} />
        ))}
        {notice && <p className="break-all text-neutral-500">{notice}</p>}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        {room ? (
          <RoomView key={`${room.workspace_id}/${room.room_id}`} session={session} api={api} room={room} />
        ) : (
          <p className="p-6 text-neutral-500">pick a room.</p>
        )}
      </main>
    </div>
  );
}

function WorkspaceItem(props: {
  api: CloudApi;
  workspace: SyncWorkspace;
  selected: CloudRoomRef | null;
  onSelect: (room: CloudRoomRef) => void;
  act: (run: () => Promise<{ ok: true } | { ok: false; failure: { error: string } | { transport: true } }>, done?: string) => Promise<void>;
  onNotice: (text: string) => void;
}) {
  const { api, workspace, selected, onSelect, act, onNotice } = props;
  const [roomName, setRoomName] = useState("");
  return (
    <section className="flex flex-col gap-1 rounded border border-neutral-200 p-2 dark:border-neutral-800">
      <div className="truncate text-neutral-500">{workspace.workspace_id} · {workspace.role}</div>
      {workspace.rooms.map((room) => (
        <button
          key={room.room_id}
          className={`${button} text-left ${selected?.room_id === room.room_id ? "bg-neutral-100 dark:bg-neutral-800" : ""}`}
          onClick={() => onSelect({ workspace_id: workspace.workspace_id, ...room })}
        >
          {room.room_id}
        </button>
      ))}
      {workspace.role === "owner" && (
        <>
          <div className="flex gap-1">
            <input className={`${field} min-w-0 flex-1`} value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="room name" />
            <button className={button} disabled={!roomName.trim()} onClick={() => void act(() => api.createRoom(workspace.workspace_id, roomName.trim())).then(() => setRoomName(""))}>add room</button>
          </div>
          <button
            className={button}
            disabled={workspace.rooms.length === 0}
            onClick={async () => {
              const result = await api.createInvite(workspace.workspace_id, { role: "member", room_ids: workspace.rooms.map((room) => room.room_id) });
              onNotice(result.ok ? `invite: ${result.value.token}` : failureText(result));
            }}
          >
            invite to all rooms
          </button>
        </>
      )}
    </section>
  );
}

function RoomView({ session, api, room }: { session: CloudSession; api: CloudApi; room: CloudRoomRef }) {
  const controller = useMemo(() => new CloudRoomController(session, api, room, window.localStorage), [session, api, room]);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const items = timeline(state);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // Braces matter: scrollIntoView returns a promise in current Chrome, and an
  // effect may only return a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [items.length]);

  // Only messages actually on screen while the window is in the foreground count as read.
  useEffect(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus() || !state.live) return;
    const unread = new Set(state.messages.filter((message) => !isRead(state.read, message.sequence)).map((message) => message.sequence));
    if (unread.size > 0) void controller.viewed(unread);
  }, [controller, state.messages, state.read, state.live]);

  const status = state.removed
    ? "you no longer have access to this room"
    : state.upgrade_required
      ? "update needed to keep reading this room"
      : state.reset_required
        ? "catching up"
        : state.live
          ? "live"
          : "connecting";

  return (
    <>
      <header className="border-b border-neutral-200 px-4 py-2 text-neutral-500 dark:border-neutral-800">
        {room.room_id} · {status}
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {items.map((item) =>
          item.kind === "message" ? (
            <div key={item.message.message_id} className="py-1">
              <span className="text-neutral-500">{item.message.actor_id === session.account_id ? "you" : item.message.actor_id}</span>{" "}
              {item.message.deleted ? <em className="text-neutral-400">deleted</em> : item.message.text}
            </div>
          ) : (
            <div key={item.entry.envelope.client_operation_id} className="flex items-center gap-2 py-1 opacity-70">
              <span className="text-neutral-500">you</span> {item.entry.envelope.text}
              <span className="text-xs text-neutral-400">{outboxLabel(item.entry)}</span>
              {item.entry.review_required && (
                <button className={button} onClick={() => controller.confirmReview(item.entry.envelope.client_operation_id)}>send anyway</button>
              )}
              {(item.entry.state === "rejected" || (item.entry.state === "draft" && !item.entry.dispatched)) && (
                <button className={button} onClick={() => controller.discard(item.entry.envelope.client_operation_id)}>discard</button>
              )}
            </div>
          ),
        )}
        <div ref={bottom} />
      </div>
      <form
        className="flex gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800"
        onSubmit={async (event) => {
          event.preventDefault();
          const text = draft;
          const result = await controller.send(text);
          if (result) setProblem(result === "no_window" ? "couldn't open a send window" : result.replace(/_/g, " "));
          else {
            setProblem(null);
            setDraft("");
          }
        }}
      >
        <input className={`${field} flex-1`} value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="message" disabled={state.removed} />
        <button className={button} disabled={!draft.trim() || state.removed}>send</button>
        {problem && <span className="self-center text-red-600">{problem}</span>}
      </form>
    </>
  );
}
