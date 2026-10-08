// Cloud rooms screen: email OTP sign-in against the issuer, then workspace,
// room and invite setup and one room thread with its outbox. Fictional data
// against local services only.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { cloudApi, currentSession, type CloudApi, type CloudSession, type SyncWorkspace } from "./api";
import { authReducer, identityProblem, type IdentityProblem } from "./auth-state";
import type { ApprovalCard as CloudCard } from "../../shared/cloud-protocol/index";
import { CloudRoomController, type CardDecision, type CloudRoomRef, type DecisionOutcome, type DownloadedAttachment, type PendingUpload } from "./controller";
import { issuer } from "./issuer";
import { outboxLabel } from "./outbox";
import { isRead } from "./read-coverage";
import { olderCursor, timeline } from "./room-reducer";
import { decidable, roomBots, visibleRuns, type RunView } from "./runs";

const field = "rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";
/** Scrolling within this distance of the top pages in older messages. */
const OLDER_THRESHOLD_PX = 120;
const button = "rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800";

function failureText(result: { ok: false; failure: { error: string } | { transport: true } }): string {
  return "error" in result.failure ? result.failure.error.replace(/_/g, " ") : "couldn't reach the server";
}

type OnIdentity = (problem: IdentityProblem | null) => void;

export function CloudRoomScreen({ baseUrl }: { baseUrl: string }) {
  const [auth, dispatch] = useReducer(authReducer, { status: "checking" });
  const onIdentity = useCallback<OnIdentity>((problem) => dispatch({ type: "identity", problem, now: Date.now() }), []);

  // The room service validates the cookie fresh against the issuer; a timeout
  // or 5xx there is identity_unavailable, never signed out.
  const check = useCallback(async () => {
    const result = await currentSession(baseUrl, null);
    if (result.ok) dispatch({ type: "checked", session: result.value });
    else onIdentity(identityProblem(result.failure) ?? { kind: "identity_unavailable" });
  }, [baseUrl, onIdentity]);
  useEffect(() => {
    void check();
  }, [check]);

  const retryAt = auth.status === "unavailable" ? auth.retry_at : auth.status === "signed_in" ? auth.unavailable_until : null;
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setTimeout(() => void check(), Math.max(0, retryAt - Date.now()));
    return () => clearTimeout(timer);
  }, [retryAt, check]);

  if (auth.status === "checking") return <p className="p-6 text-sm text-neutral-500">checking sign-in...</p>;
  if (auth.status === "unavailable") {
    return (
      <div className="flex max-w-sm flex-col gap-2 p-6 text-sm">
        <p>can't confirm your sign-in right now. retrying.</p>
        <button className={button} onClick={() => void check()}>retry now</button>
      </div>
    );
  }
  if (auth.status === "signed_out" || auth.status === "revoked") {
    return <SignIn revoked={auth.status === "revoked"} onSignedIn={check} />;
  }
  return (
    <SignedIn
      session={auth.session}
      unavailable={auth.unavailable_until !== null}
      onIdentity={onIdentity}
      onSignedOut={() => dispatch({ type: "signed_out" })}
    />
  );
}

function SignIn({ revoked, onSignedIn }: { revoked: boolean; onSignedIn: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } finally {
      setBusy(false);
    }
  };
  const sendCode = (address: string) =>
    run(async () => {
      const result = await issuer.sendCode(address);
      if (result.ok) {
        setSentTo(address);
        setCode("");
      } else setError(result.message);
    });

  return (
    <form
      className="flex max-w-sm flex-col gap-2 p-6 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!sentTo) return void sendCode(email.trim());
        void run(async () => {
          const result = await issuer.verifyCode(sentTo, code.trim());
          if (result.ok) await onSignedIn();
          else setError(result.message);
        });
      }}
    >
      {revoked && <p>you were signed out. sign in again to keep using cloud rooms.</p>}
      {sentTo ? (
        <>
          <label htmlFor="cloud-otp">code sent to {sentTo}</label>
          <input id="cloud-otp" className={field} value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus />
          <button className={button} disabled={busy || !code.trim()}>sign in</button>
          <div className="flex gap-2">
            <button type="button" className={button} disabled={busy} onClick={() => void sendCode(sentTo)}>send a new code</button>
            <button type="button" className={button} disabled={busy} onClick={() => setSentTo(null)}>use another email</button>
          </div>
        </>
      ) : (
        <>
          <label htmlFor="cloud-email">email</label>
          <input id="cloud-email" className={field} type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" autoFocus />
          <button className={button} disabled={busy || !email.trim()}>email me a code</button>
        </>
      )}
      {error && <p className="text-red-600">{error}</p>}
    </form>
  );
}

function SignedIn(props: { session: CloudSession; unavailable: boolean; onIdentity: OnIdentity; onSignedOut: () => void }) {
  const { session, unavailable, onIdentity, onSignedOut } = props;
  const api = useMemo(() => cloudApi(session, onIdentity), [session, onIdentity]);
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
  // A stable handle so a room's controller can ask for discovery again after authority_changed.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const rediscover = useCallback(() => void refreshRef.current(), []);

  const act = async (run: () => Promise<{ ok: true } | { ok: false; failure: { error: string } | { transport: true } }>, done?: string) => {
    const result = await run();
    setNotice(result.ok ? (done ?? null) : failureText(result));
    await refresh();
  };

  return (
    <div className="flex h-screen text-sm">
      <aside className="flex w-72 flex-col gap-3 overflow-y-auto border-r border-neutral-200 p-3 dark:border-neutral-800">
        <div className="flex items-center justify-between">
          <span className="truncate" title={session.subject}>{session.subject}</span>
          <button
            className={button}
            onClick={async () => {
              const result = await issuer.signOut();
              if (result.ok) onSignedOut();
              else setNotice(result.message);
            }}
          >
            sign out
          </button>
        </div>
        {unavailable && <p className="text-amber-600">can't confirm your sign-in right now. retrying.</p>}
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
          <RoomView key={`${room.workspace_id}/${room.room_id}`} session={session} api={api} room={room} onIdentity={onIdentity} onAuthorityChanged={rediscover} />
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

function RoomView(props: { session: CloudSession; api: CloudApi; room: CloudRoomRef; onIdentity: OnIdentity; onAuthorityChanged: () => void }) {
  const { session, api, room, onIdentity, onAuthorityChanged } = props;
  const controller = useMemo(
    () => new CloudRoomController(session, api, room, window.localStorage, WebSocket, onIdentity, undefined, onAuthorityChanged),
    [session, api, room, onIdentity, onAuthorityChanged],
  );
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const uploads = useSyncExternalStore(controller.subscribe, controller.getUploads);
  const items = timeline(state);
  const runs = visibleRuns(state.runs, Date.now());
  const bots = useMemo(() => roomBots(state.runs, state.messages), [state.runs, state.messages]);
  const [draft, setDraft] = useState("");
  /** Bots picked from the strip; spans are found in the final text at send time. */
  const [picked, setPicked] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploading = uploads.some((upload) => upload.state !== "ready" && upload.state !== "failed" && upload.state !== "rejected" && upload.state !== "expired");
  const readyIds = uploads.filter((upload) => upload.state === "ready" && upload.attachment_id).map((upload) => upload.attachment_id!);
  const [problem, setProblem] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  /** The oldest message and the distance from the bottom when an older page was asked for. */
  const anchor = useRef<{ first: string; fromBottom: number } | null>(null);
  const last = items.at(-1);
  const lastKey = last ? (last.kind === "message" ? last.message.message_id : last.entry.envelope.client_operation_id) : null;
  const canLoadOlder = olderCursor(state) !== null;

  // Follow the newest message, not the count: an older page grows the list at the top.
  // Braces matter: scrollIntoView returns a promise in current Chrome, and an
  // effect may only return a cleanup function.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lastKey, runs.length]);

  const loadOlder = useCallback(() => {
    const element = scroller.current;
    const first = controller.getState().messages[0];
    if (!element || !first || olderCursor(controller.getState()) === null) return;
    anchor.current = { first: first.message_id, fromBottom: element.scrollHeight - element.scrollTop };
    void controller.loadOlder();
  }, [controller]);

  // Keep the reader on the same message when a page lands above it.
  useLayoutEffect(() => {
    const element = scroller.current;
    const saved = anchor.current;
    if (!element || !saved || state.older_before !== null) return;
    anchor.current = null;
    // Only when the page joined in front of what was on screen (not after a reset or failure).
    if (state.messages.findIndex((message) => message.message_id === saved.first) > 0) element.scrollTop = element.scrollHeight - saved.fromBottom;
  }, [state.messages, state.older_before]);

  // Only messages actually on screen while the window is in the foreground count as read.
  useEffect(() => {
    if (document.visibilityState !== "visible" || !document.hasFocus() || !state.live) return;
    const unread = new Set(state.messages.filter((message) => !isRead(state.read, message.sequence)).map((message) => message.sequence));
    if (unread.size > 0) void controller.viewed(unread);
  }, [controller, state.messages, state.read, state.live]);

  const status = state.removed
    ? "you no longer have access to this room"
    : !state.online
      ? "offline · messages wait here and send when you reconnect"
      : state.upgrade_required
      ? "update needed to keep reading this room"
      : state.reset_required
        ? state.reset_reason === "authority_changed"
          ? "this room moved · reloading"
          : "catching up"
        : state.live
          ? "live"
          : "connecting";

  return (
    <>
      <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 px-4 py-2 text-neutral-500 dark:border-neutral-800">
        <span>{room.room_id} · {status}</span>
        {!state.removed &&
          bots.map((bot) => (
            <button
              key={bot.bot_id}
              className={button}
              title={bot.host_online === false ? "its host is offline; a mention waits up to 24h" : "mention"}
              onClick={() => {
                setDraft((text) => `${text}${text && !text.endsWith(" ") ? " " : ""}@${bot.name} `);
                setPicked((ids) => (ids.includes(bot.bot_id) ? ids : [...ids, bot.bot_id]));
              }}
            >
              <span className={bot.host_online ? "text-green-600" : "text-neutral-400"}>●</span> @{bot.name}
              {bot.host_online === false && <span className="text-xs text-neutral-400"> host offline</span>}
            </button>
          ))}
      </header>
      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-4 py-2"
        onScroll={(event) => {
          if (event.currentTarget.scrollTop < OLDER_THRESHOLD_PX) loadOlder();
        }}
      >
        {!state.removed && state.messages.length > 0 && (
          <div className="py-1 text-center text-xs text-neutral-400">
            {state.older_before !== null ? (
              "loading earlier messages"
            ) : state.start_loaded ? (
              "start of the thread"
            ) : (
              // Also the way in when the loaded page doesn't fill the view and can't scroll.
              <button className={button} onClick={loadOlder} disabled={!canLoadOlder}>
                {state.older_failed ? "couldn't load earlier messages · retry" : "load earlier messages"}
              </button>
            )}
          </div>
        )}
        {items.map((item) =>
          item.kind === "message" ? (
            <div key={item.message.message_id} className="whitespace-pre-wrap py-1">
              <span className="text-neutral-500">{item.message.bot_id ? `@${item.message.bot_id}` : item.message.actor_id === session.account_id ? "you" : item.message.actor_id}</span>{" "}
              {item.message.deleted ? <em className="text-neutral-400">deleted</em> : item.message.text}
              {!item.message.deleted &&
                item.message.attachment_ids?.map((id) => <AttachmentView key={id} controller={controller} attachmentId={id} />)}
            </div>
          ) : (
            <div key={item.entry.envelope.client_operation_id} className="flex items-center gap-2 py-1 opacity-70">
              <span className="text-neutral-500">you</span> <span className="whitespace-pre-wrap">{item.entry.envelope.text}</span>
              <span className="text-xs text-neutral-400">{outboxLabel(item.entry)}</span>
              {item.entry.review_required && (
                <button
                  className={button}
                  onClick={async () => {
                    const result = await controller.confirmReview(item.entry.envelope.client_operation_id);
                    if (result) setProblem(result === "no_window" ? "couldn't open a send window" : result.replace(/_/g, " "));
                  }}
                >
                  {item.entry.legacy_epoch ? "send again" : "send anyway"}
                </button>
              )}
              {(item.entry.state === "rejected" || (item.entry.state === "draft" && !item.entry.dispatched)) && (
                <button className={button} onClick={() => controller.discard(item.entry.envelope.client_operation_id)}>discard</button>
              )}
            </div>
          ),
        )}
        {!state.removed &&
          runs.map((view) => <RunRow key={view.run.invocation_id} view={view} name={`@${view.run.bot_id}`} controller={controller} accountId={session.account_id} />)}
        <div ref={bottom} />
      </div>
      {uploads.length > 0 && !state.removed && (
        <div className="flex flex-wrap gap-2 border-t border-neutral-200 px-3 pt-2 dark:border-neutral-800">
          {uploads.map((upload) => <UploadChip key={upload.local_id} upload={upload} onRemove={() => controller.removeUpload(upload.local_id)} />)}
        </div>
      )}
      <form
        className="flex gap-2 border-t border-neutral-200 p-3 dark:border-neutral-800"
        onSubmit={async (event) => {
          event.preventDefault();
          const text = draft;
          if (uploading) return setProblem("wait for files to finish");
          const result = await controller.send(text, mentionSpans(text, picked, bots), readyIds);
          if (result) setProblem(result === "no_window" ? (state.online ? "couldn't open a send window" : "offline, and this room has no saved send window yet") : result.replace(/_/g, " "));
          else {
            setProblem(null);
            setDraft("");
            setPicked([]);
          }
        }}
      >
        {/* A textarea, not an input: an input strips the newline out of a multi-line message. */}
        <textarea
          className={`${field} flex-1 resize-none`}
          rows={Math.min(6, draft.split("\n").length)}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if ((draft.trim() || readyIds.length > 0) && !state.removed) event.currentTarget.form?.requestSubmit();
          }}
          placeholder="message"
          disabled={state.removed}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            for (const file of Array.from(event.target.files ?? [])) void controller.attach(file);
            event.target.value = "";
          }}
        />
        <button type="button" className={button} disabled={state.removed || !state.online} title={state.online ? "attach files" : "files can't upload offline"} onClick={() => fileInput.current?.click()}>
          attach
        </button>
        <button className={button} disabled={(!draft.trim() && readyIds.length === 0) || uploading || state.removed}>send</button>
        {problem && <span className="self-center text-red-600">{problem}</span>}
      </form>
    </>
  );
}

/** Mention spans for picked bots whose @name is still in the text; plain typed @text stays plain. */
export function mentionSpans(text: string, picked: readonly string[], bots: ReadonlyArray<{ bot_id: string; name: string }>) {
  const spans: Array<{ kind: "bot"; id: string; start: number; end: number }> = [];
  for (const id of picked) {
    const bot = bots.find((candidate) => candidate.bot_id === id);
    if (!bot) continue;
    const token = `@${bot.name}`;
    let from = 0;
    for (;;) {
      const start = text.indexOf(token, from);
      if (start < 0) break;
      const end = start + token.length;
      from = end;
      // Whole-token only, so "@ana" never claims part of "@anabot".
      if (end < text.length && /[\p{L}\p{N}_-]/u.test(text[end])) continue;
      if (spans.some((span) => start < span.end && span.start < end)) continue;
      spans.push({ kind: "bot", id, start, end });
      break;
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

function RunRow({ view, name, controller, accountId }: { view: RunView; name: string; controller: CloudRoomController; accountId: string }) {
  const { stream, card, label } = view;
  return (
    <div className="flex flex-col gap-1 py-1">
      <div>
        <span className="text-neutral-500">{name}</span> <span className="text-xs text-neutral-400">{label}</span>
      </div>
      {stream?.text && (
        // Provisional: replaced by the committed reply, never counted as read or sent.
        <div className="whitespace-pre-wrap italic text-neutral-500">{stream.text}</div>
      )}
      {card && <ApprovalCard card={card} controller={controller} accountId={accountId} />}
    </div>
  );
}

const DECISION_TEXT: Record<DecisionOutcome, string | null> = {
  decided: null,
  offline: "you're offline. decisions are never queued; try again when you're back.",
  not_decidable: "this can't be decided anymore.",
  already_decided: "someone else decided first.",
  failed: "couldn't confirm the decision. it may still have gone through; the card updates when the room catches up.",
};

function ApprovalCard({ card, controller, accountId }: { card: CloudCard; controller: CloudRoomController; accountId: string }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const open = decidable(card, accountId, Date.now());
  const decide = async (decision: CardDecision) => {
    setBusy(true);
    const outcome = await controller.decide(card, decision);
    setBusy(false);
    setNotice(DECISION_TEXT[outcome]);
  };
  // View and decide are separate: everyone in the room sees the card, only the person who asked decides.
  const settled =
    card.status === "pending"
      ? Date.parse(card.expires_at) <= Date.now()
        ? "expired"
        : card.actor_id === accountId
          ? null
          : `waiting for ${card.actor_id} to decide`
      : card.status === "approved" || card.status === "denied"
        ? `${card.status} by ${card.actor_id === accountId ? "you" : card.actor_id}`
        : card.status;
  return (
    <div className="flex max-w-xl flex-col gap-1 rounded border border-amber-300 p-2 dark:border-amber-700">
      <div className="font-medium">{card.title}</div>
      {open ? (
        <div className="flex gap-2">
          <button className={button} disabled={busy} onClick={() => void decide("approve")}>approve</button>
          <button className={button} disabled={busy} onClick={() => void decide("deny")}>deny</button>
        </div>
      ) : (
        <div className="text-xs text-neutral-500">{settled}</div>
      )}
      {notice && <div className="text-xs text-amber-700">{notice}</div>}
    </div>
  );
}

/** Opened on demand: every open goes through the reauthorizing download proxy, images show inline. */
function AttachmentView({ controller, attachmentId }: { controller: CloudRoomController; attachmentId: string }) {
  const [viewed, setViewed] = useState<DownloadedAttachment | null>(null);
  const [failed, setFailed] = useState(false);
  const name = controller.attachmentName(attachmentId) ?? "attachment";
  if (failed) return <div className="text-xs text-neutral-400">{name} · can't open</div>;
  if (viewed?.type.startsWith("image/")) return <img src={viewed.url} alt={name} className="mt-1 max-h-64 max-w-sm rounded" />;
  return (
    <button
      className={`${button} mt-1 block text-xs`}
      onClick={async () => {
        const result = await controller.download(attachmentId);
        if (!result) return setFailed(true);
        if (result.type.startsWith("image/")) return setViewed(result);
        const anchor = document.createElement("a");
        anchor.href = result.url;
        anchor.download = name;
        anchor.click();
      }}
    >
      {name} · open
    </button>
  );
}

function UploadChip({ upload, onRemove }: { upload: PendingUpload; onRemove: () => void }) {
  const done = upload.state === "ready";
  const failed = upload.state === "failed" || upload.state === "rejected" || upload.state === "expired";
  return (
    <span className={`flex items-center gap-1 rounded border px-2 py-0.5 text-xs ${failed ? "border-red-300 text-red-600" : "border-neutral-300 dark:border-neutral-700"}`}>
      {upload.name} · {failed ? `not attached: ${upload.problem ?? upload.state}` : done ? formatBytes(upload.size) : `${upload.state}...`}
      <button type="button" aria-label={`remove ${upload.name}`} onClick={onRemove}>×</button>
    </span>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
