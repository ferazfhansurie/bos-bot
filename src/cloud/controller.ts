// Drives one cloud room: owns the reducer state, persists the outbox before
// any network I/O, works the outbox sequentially and keeps the realtime
// subscription caught up through resets and reconnects.
import { LIMITS, type SendEnvelope } from "../../shared/cloud-protocol/index";
import { connectRealtime, type CloudApi, type CloudSession, type OperationWindow, type RealtimeConnection } from "./api";
import { backoffMs, freezeSend, localOutboxStore, memoryOutboxStore, nextWork, type EnvelopeProblem, type OutboxStore } from "./outbox";
import { isEligible, markViewed } from "./read-coverage";
import { cloudRoomReducer, initialCloudRoomState, type CloudRoomAction, type CloudRoomState } from "./room-reducer";
import { compareSequence } from "./sequence";

type OutboxNamespace = SendEnvelope["namespace"];

export interface CloudRoomRef {
  workspace_id: string;
  room_id: string;
  thread_id: string;
  policy_revision: string;
  /** Guests keep content and drafts in session memory only. */
  guest?: boolean;
}

export function namespaceKey(session: Pick<CloudSession, "service" | "issuer" | "subject">): string {
  return [session.service, session.issuer, session.subject].join(":");
}

export class CloudRoomController {
  private state: CloudRoomState;
  private readonly listeners = new Set<() => void>();
  private readonly store: OutboxStore;
  private connection: RealtimeConnection | null = null;
  private window: OperationWindow | null = null;
  private pumping = false;
  private pumpAgain = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private resetting = false;
  /** The loaded page reaches the first message of the thread. */
  private threadStartLoaded = false;
  private readonly identity: OutboxNamespace;

  constructor(
    private readonly session: CloudSession,
    private readonly api: CloudApi,
    private readonly room: CloudRoomRef,
    storage: Pick<Storage, "getItem" | "setItem"> | null,
    private readonly Socket: typeof WebSocket = WebSocket,
  ) {
    // Workspace and epoch are not compared when matching an identity.
    this.identity = { service: session.service, issuer: session.issuer, subject: session.subject, account_id: session.account_id, workspace_id: room.workspace_id, epoch: "" };
    this.store = room.guest || !storage ? memoryOutboxStore() : localOutboxStore(storage, this.identity);
    this.state = {
      ...initialCloudRoomState({
        namespace: namespaceKey(session),
        account_id: session.account_id,
        workspace_id: room.workspace_id,
        room_id: room.room_id,
        thread_id: room.thread_id,
        outbox: this.store.load(),
      }),
      policy_revision: room.policy_revision,
    };
  }

  getState = (): CloudRoomState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    this.dispatch({ type: "outbox", action: { type: "restored", now: Date.now() } });
    this.dispatch({ type: "outbox", action: { type: "tick", now: Date.now() } });
    this.connect();
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.connection?.close();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  }

  private dispatch(action: CloudRoomAction): void {
    const previous = this.state;
    this.state = cloudRoomReducer(previous, action);
    if (this.state === previous) return;
    // The outbox is durable before anything is transmitted.
    if (this.state.outbox !== previous.outbox) this.store.save(this.state.outbox);
    for (const listener of this.listeners) listener();
  }

  private async ensureWindow(): Promise<OperationWindow | null> {
    if (this.window && Date.parse(this.window.expires_at) - Date.now() > 60_000) return this.window;
    const result = await this.api.openWindow(this.room.workspace_id);
    this.window = result.ok ? result.value : null;
    return this.window;
  }

  /** Freeze and queue a send. Returns a problem when the draft must stay in the composer. */
  async send(text: string): Promise<EnvelopeProblem | "no_window" | null> {
    const window = await this.ensureWindow();
    if (!window) return "no_window";
    const entry = await freezeSend({
      namespace: window.namespace,
      window_id: window.window_id,
      window_token: window.window_token,
      room_id: this.room.room_id,
      thread_id: this.room.thread_id,
      text,
      mentions: [],
      expected_policy_revision: this.state.policy_revision ?? this.room.policy_revision,
      now: Date.now(),
    });
    if ("problem" in entry) return entry.problem;
    this.dispatch({ type: "outbox", action: { type: "queued", entry } });
    void this.pump();
    return null;
  }

  confirmReview(operationId: string): void {
    this.dispatch({ type: "outbox", action: { type: "review_confirmed", id: operationId, now: Date.now() } });
    void this.pump();
  }

  discard(operationId: string): void {
    this.dispatch({ type: "outbox", action: { type: "discard", id: operationId } });
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      this.pumpAgain = true;
      return;
    }
    this.pumping = true;
    try {
      do {
        this.pumpAgain = false;
        const work = nextWork(this.state.outbox, this.identity, Date.now());
        await Promise.all(work.map((item) => this.perform(item.kind, item.entry.envelope.client_operation_id)));
        if (work.length > 0) this.pumpAgain = true;
      } while (this.pumpAgain && !this.stopped);
    } finally {
      this.pumping = false;
      this.scheduleRetry();
    }
  }

  private async perform(kind: "send" | "lookup", operationId: string): Promise<void> {
    const entry = this.state.outbox.find((item) => item.envelope.client_operation_id === operationId);
    if (!entry) return;
    if (kind === "send") {
      this.dispatch({ type: "outbox", action: { type: "dispatching", id: operationId } });
      const result = await this.api.send(entry.envelope);
      if (result.ok) this.dispatch({ type: "operation", result: result.value, now: Date.now() });
      else this.dispatch({ type: "outbox", action: { type: "send_failed", id: operationId, now: Date.now(), failure: result.failure } });
      return;
    }
    const result = await this.api.lookup(entry.envelope.namespace.workspace_id, operationId);
    if (result.ok) this.dispatch({ type: "operation", result: result.value, now: Date.now() });
    else this.dispatch({ type: "outbox", action: { type: "lookup_failed", id: operationId, now: Date.now(), retry_after: "error" in result.failure ? result.failure.retry_after : undefined } });
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const next = this.state.outbox.map((entry) => entry.retry_at).filter((at): at is number => at !== undefined).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.retryTimer = setTimeout(() => void this.pump(), Math.max(0, next - Date.now()));
  }

  private connect(): void {
    if (this.stopped) return;
    this.connection = connectRealtime(
      this.session,
      {
        onOpen: () => {
          this.reconnectAttempts = 0;
          this.resubscribe();
          // A new connection is a good moment to recheck anything unresolved.
          void this.pump();
        },
        onFrame: (frame) => {
          if (frame.type === "reset_required" && frame.snapshot) this.threadStartLoaded = frame.snapshot.messages.length < LIMITS.snapshotMessages;
          this.dispatch({ type: "frame", frame });
          // A server reset or a batch that failed validation both recover from a snapshot.
          if (this.state.reset_required) void this.reset();
          else if (frame.type === "reset_required") this.resubscribe();
        },
        onClose: () => {
          this.dispatch({ type: "disconnected" });
          if (this.stopped) return;
          this.reconnectTimer = setTimeout(() => this.connect(), backoffMs(this.reconnectAttempts++));
        },
      },
      this.Socket,
    );
  }

  private resubscribe(): void {
    this.connection?.subscribe({
      workspace_id: this.room.workspace_id,
      room_id: this.room.room_id,
      thread_id: this.room.thread_id,
      cursor: this.state.cursor,
      snapshot_id: this.state.snapshot_id,
    });
  }

  private async reset(): Promise<void> {
    if (this.resetting) return;
    this.resetting = true;
    try {
      const result = await this.api.snapshot(this.room.workspace_id, this.room.room_id, this.room.thread_id);
      if (result.ok) {
        this.threadStartLoaded = result.value.messages.length < LIMITS.snapshotMessages;
        this.dispatch({ type: "snapshot", snapshot: result.value });
        this.resubscribe();
      }
    } finally {
      this.resetting = false;
    }
  }

  /**
   * Record which loaded messages were actually visible in the foreground.
   * The run bridges to the thread start only when the whole thread is loaded.
   */
  async viewed(sequences: ReadonlySet<string>): Promise<void> {
    const eligible = this.state.messages
      .filter((message) => isEligible(message, this.state.account_id))
      .map((message) => message.sequence)
      .sort(compareSequence);
    const result = markViewed(this.state.read, { sequences: eligible, after: this.threadStartLoaded ? null : undefined }, sequences);
    if (result.post.length === 0) return;
    this.dispatch({ type: "read", coverage: result.coverage });
    const saved = await this.api.postRead(this.room.workspace_id, this.room.room_id, { thread_id: this.room.thread_id, intervals: result.post });
    if (saved.ok) this.dispatch({ type: "read", coverage: saved.value });
  }
}
