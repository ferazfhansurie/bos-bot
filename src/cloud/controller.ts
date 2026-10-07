// Drives one cloud room: owns the reducer state, persists the outbox before
// any network I/O, works the outbox sequentially and keeps the realtime
// subscription caught up through resets and reconnects.
import { ATTACHMENT_LIMITS, LIMITS, type ApprovalCard, type CloudAttachment, type SendEnvelope } from "../../shared/cloud-protocol/index";
import { identityProblem, type IdentityProblem } from "./auth-state";
import { connectRealtime, type CloudApi, type CloudSession, type OperationWindow, type RealtimeConnection } from "./api";
import {
  backoffMs,
  freezeSend,
  localOutboxStore,
  localWindowStore,
  memoryOutboxStore,
  memoryWindowStore,
  nextWork,
  type EnvelopeProblem,
  type OutboxStore,
  type WindowStore,
} from "./outbox";
import { decidable } from "./runs";
import { isEligible, markViewed } from "./read-coverage";
import { cloudRoomReducer, initialCloudRoomState, type CloudRoomAction, type CloudRoomState } from "./room-reducer";
import { compareSequence } from "./sequence";

type OutboxNamespace = SendEnvelope["namespace"];
type Mention = SendEnvelope["mentions"][number];

/** Where the controller hears about the device going on and offline. */
export interface NetworkSource {
  online(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export const browserNetwork: NetworkSource = {
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  subscribe(listener) {
    if (typeof window === "undefined") return () => {};
    const up = () => listener(true);
    const down = () => listener(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  },
};

/** A file on its way to ready. Session memory only; never auto-sent. */
export interface PendingUpload {
  local_id: string;
  name: string;
  size: number;
  content_type: string;
  state: CloudAttachment["state"] | "failed";
  attachment_id?: string;
  problem?: string;
}

export type CardDecision = "approve" | "deny";
/** A viewed attachment: a session-local object URL plus the type the server served it as. */
export interface DownloadedAttachment {
  url: string;
  type: string;
}
type AllowedType = (typeof ATTACHMENT_LIMITS.types)[number];
const ALLOWED_TYPES: ReadonlySet<string> = new Set(ATTACHMENT_LIMITS.types);

export type DecisionOutcome = "decided" | "offline" | "not_decidable" | "already_decided" | "failed";

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
  // Bumped on every connect and stop so a closed socket's late callbacks are ignored.
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private resetting = false;
  /** The loaded page reaches the first message of the thread. */
  private threadStartLoaded = false;
  private readonly identity: OutboxNamespace;
  private readonly windows: WindowStore;
  private unsubscribeNetwork: (() => void) | null = null;
  private uploads: PendingUpload[] = [];
  private readonly downloads = new Map<string, Promise<DownloadedAttachment | null>>();
  /** Display names for this device's own uploads; the room wire carries attachment ids only. */
  private readonly attachmentNames = new Map<string, string>();

  constructor(
    private readonly session: CloudSession,
    private readonly api: CloudApi,
    private readonly room: CloudRoomRef,
    storage: Pick<Storage, "getItem" | "setItem"> | null,
    private readonly Socket: typeof WebSocket = WebSocket,
    private readonly onIdentity: (problem: IdentityProblem) => void = () => {},
    private readonly network: NetworkSource = browserNetwork,
  ) {
    // Workspace and epoch are not compared when matching an identity.
    this.identity = { service: session.service, issuer: session.issuer, subject: session.subject, account_id: session.account_id, workspace_id: room.workspace_id, epoch: "" };
    this.store = room.guest || !storage ? memoryOutboxStore() : localOutboxStore(storage, this.identity);
    this.windows = room.guest || !storage ? memoryWindowStore() : localWindowStore(storage, this.identity);
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
  getUploads = (): PendingUpload[] => this.uploads;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    // StrictMode runs start, stop, start on one controller.
    this.stopped = false;
    this.dispatch({ type: "outbox", action: { type: "restored", now: Date.now() } });
    this.dispatch({ type: "outbox", action: { type: "tick", now: Date.now() } });
    this.dispatch({ type: "network", online: this.network.online() });
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = this.network.subscribe((online) => this.networkChanged(online));
    this.connect();
    void this.pump();
  }

  /** Back online: reconnect now instead of waiting out the backoff, then replay the outbox. */
  private networkChanged(online: boolean): void {
    if (this.stopped) return;
    this.dispatch({ type: "network", online });
    if (!online) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
      this.connect();
    }
    void this.pump();
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    this.unsubscribeNetwork?.();
    this.unsubscribeNetwork = null;
    this.releaseDownloads();
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
    // Losing the room drops uploads and viewable files at once.
    if (this.state.removed && !previous.removed) {
      this.uploads = [];
      this.releaseDownloads();
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * A window still valid for a minute. Offline, a member reuses the saved one
   * so the send can queue; the server rechecks it when the outbox replays.
   */
  private async ensureWindow(): Promise<Pick<OperationWindow, "namespace" | "window_id" | "window_token" | "expires_at"> | null> {
    const fresh = (window: { expires_at: string } | null) => window !== null && Date.parse(window.expires_at) - Date.now() > 60_000;
    if (this.window && fresh(this.window)) return this.window;
    const saved = this.windows.load();
    if (!this.state.online) return fresh(saved) ? saved : null;
    const result = await this.api.openWindow(this.room.workspace_id);
    if (!result.ok) {
      this.window = null;
      // Unreachable is like offline; a refusal from the server is not.
      return "transport" in result.failure && fresh(saved) ? saved : null;
    }
    this.window = result.value;
    this.windows.save({ window_id: result.value.window_id, window_token: result.value.window_token, expires_at: result.value.expires_at, namespace: result.value.namespace });
    return this.window;
  }

  /** Freeze and queue a send. Returns a problem when the draft must stay in the composer. */
  async send(text: string, mentions: Mention[] = [], attachmentIds: string[] = []): Promise<EnvelopeProblem | "no_window" | "removed" | null> {
    if (this.state.removed) return "removed";
    const window = await this.ensureWindow();
    if (!window) return "no_window";
    const entry = await freezeSend({
      namespace: window.namespace,
      window_id: window.window_id,
      window_token: window.window_token,
      room_id: this.room.room_id,
      thread_id: this.room.thread_id,
      text,
      mentions,
      attachment_ids: attachmentIds,
      expected_policy_revision: this.state.policy_revision ?? this.room.policy_revision,
      now: Date.now(),
    });
    if ("problem" in entry) return entry.problem;
    this.dispatch({ type: "outbox", action: { type: "queued", entry } });
    if (attachmentIds.length > 0) this.setUploads(this.uploads.filter((upload) => !upload.attachment_id || !attachmentIds.includes(upload.attachment_id)));
    void this.pump();
    return null;
  }

  /**
   * Decide an approval card. Decisions are online only and never enter the
   * offline outbox; a lost response retries the same operation while the
   * card is still pending, and the server lets one valid decision win.
   */
  async decide(card: ApprovalCard, decision: CardDecision): Promise<DecisionOutcome> {
    if (!this.state.online) return "offline";
    if (this.state.removed || !decidable(card, this.session.account_id, Date.now())) return "not_decidable";
    // Bound to the exact card version, effect digest and run generation; a stale card fails closed.
    const body = { invocation_id: card.invocation_id, attempt: card.attempt, fence_gen: card.fence_gen, version: card.version, effect_id: card.effect_id, digest: card.digest, decision };
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await this.api.decideCard(this.room.workspace_id, card.room_id, card.approval_id, body);
      if (result.ok) {
        this.dispatch({ type: "card", card: result.value });
        return result.value.status === (decision === "approve" ? "approved" : "denied") ? "decided" : "already_decided";
      }
      if ("error" in result.failure) {
        // A retry after a lost response lands here too: the first attempt already won.
        if (["approval_decided", "approval_expired", "control_conflict"].includes(result.failure.error)) return "already_decided";
        return "failed";
      }
      const current = this.state.runs.cards[card.approval_id];
      if (this.stopped || !this.state.online || (current && !decidable(current, this.session.account_id, Date.now()))) break;
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
    }
    return "failed";
  }

  private setUploads(uploads: PendingUpload[]): void {
    this.uploads = uploads;
    this.emit();
  }

  private patchUpload(localId: string, patch: Partial<PendingUpload>): void {
    if (!this.uploads.some((upload) => upload.local_id === localId)) return;
    this.setUploads(this.uploads.map((upload) => (upload.local_id === localId ? { ...upload, ...patch } : upload)));
  }

  /** Upload one file: prepare, PUT the bytes, then let the server verify (checksum + scan) it. */
  async attach(file: Blob & { name?: string }): Promise<void> {
    const localId = randomHex(8);
    const upload: PendingUpload = { local_id: localId, name: (file.name || "file").slice(0, 256), size: file.size, content_type: file.type, state: "preparing" };
    if (this.state.removed) return;
    const refuse = (problem: string) => this.setUploads([...this.uploads, { ...upload, state: "failed", problem }]);
    if (file.size > ATTACHMENT_LIMITS.bytes) return refuse("too large");
    if (file.size === 0) return refuse("empty file");
    if (!ALLOWED_TYPES.has(file.type)) return refuse("only png, jpeg, pdf or plain text");
    if (this.uploads.filter((item) => item.state !== "failed").length >= MAX_ATTACHMENTS_PER_MESSAGE) return refuse("too many files");
    if (!this.state.online) return refuse("offline");
    this.setUploads([...this.uploads, upload]);
    const checksum = await sha256Hex(file);
    const allocation = await this.api.allocateAttachment(this.room.workspace_id, {
      room_id: this.room.room_id,
      thread_id: this.room.thread_id,
      name: upload.name,
      size: file.size,
      type: file.type as AllowedType,
      checksum,
    });
    if (!allocation.ok) return this.patchUpload(localId, { state: "failed", problem: problemText(allocation.failure) });
    const attachmentId = allocation.value.attachment.attachment_id;
    this.patchUpload(localId, { state: "uploading", attachment_id: attachmentId });
    const put = await this.api.upload(allocation.value.upload_url, file, file.type);
    if (!put.ok) return this.patchUpload(localId, { state: "failed", problem: problemText(put.failure) });
    this.patchUpload(localId, { state: "verifying" });
    // Completion verifies and scans before answering; a scanner outage stays quarantined, so retry briefly.
    let status = await this.api.completeAttachment(this.room.workspace_id, attachmentId);
    for (let attempt = 0; attempt < 4 && !status.ok && !this.stopped && retryable(status.failure); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
      status = await this.api.completeAttachment(this.room.workspace_id, attachmentId);
    }
    if (!status.ok) return this.patchUpload(localId, { state: "failed", problem: problemText(status.failure) });
    if (status.value.state === "ready") this.attachmentNames.set(attachmentId, status.value.name);
    this.patchUpload(localId, { state: status.value.state, problem: status.value.state === "ready" ? undefined : status.value.state });
  }

  attachmentName(attachmentId: string): string | undefined {
    return this.attachmentNames.get(attachmentId);
  }

  removeUpload(localId: string): void {
    this.setUploads(this.uploads.filter((upload) => upload.local_id !== localId));
  }

  /** An object URL for a committed attachment, fetched through the reauthorizing proxy. */
  download(attachmentId: string): Promise<DownloadedAttachment | null> {
    if (this.state.removed) return Promise.resolve(null);
    let pending = this.downloads.get(attachmentId);
    if (!pending) {
      pending = this.api.download(this.room.workspace_id, attachmentId).then((result) => {
        if (!result.ok || this.state.removed || this.stopped) {
          this.downloads.delete(attachmentId);
          return null;
        }
        return { url: URL.createObjectURL(result.value), type: result.value.type };
      });
      this.downloads.set(attachmentId, pending);
    }
    return pending;
  }

  private releaseDownloads(): void {
    for (const pending of this.downloads.values()) void pending.then((viewed) => viewed && URL.revokeObjectURL(viewed.url));
    this.downloads.clear();
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
        // Offline, nothing can be delivered; the outbox replays when the network returns.
        if (!this.state.online || this.state.removed) break;
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
    if (this.stopped || !this.state.online || this.state.removed) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    const next = this.state.outbox.map((entry) => entry.retry_at).filter((at): at is number => at !== undefined).sort((a, b) => a - b)[0];
    if (next === undefined) return;
    this.retryTimer = setTimeout(() => void this.pump(), Math.max(0, next - Date.now()));
  }

  private connect(): void {
    if (this.stopped) return;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.connection = connectRealtime(
      this.session,
      {
        onOpen: () => {
          if (!current()) return;
          this.reconnectAttempts = 0;
          this.resubscribe();
          // A new connection is a good moment to recheck anything unresolved.
          void this.pump();
        },
        onFrame: (frame) => {
          if (!current()) return;
          const problem = frame.type === "error" ? identityProblem({ error: frame.error, status: 0 }) : null;
          if (problem) {
            this.onIdentity(problem);
            // A revoked session can't reconnect; identity_unavailable retries on close as usual.
            if (problem.kind === "session_invalid") this.stop();
            return;
          }
          if (frame.type === "reset_required" && frame.snapshot) this.threadStartLoaded = frame.snapshot.messages.length < LIMITS.snapshotMessages;
          this.dispatch({ type: "frame", frame });
          // A server reset or a batch that failed validation both recover from a snapshot.
          if (this.state.reset_required) void this.reset();
          else if (frame.type === "reset_required") this.resubscribe();
        },
        onClose: () => {
          if (!current()) return;
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

function randomHex(bytes: number): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(blob: Blob): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function problemText(failure: { error: string } | { transport: true }): string {
  return "error" in failure ? failure.error.replace(/_/g, " ") : "couldn't reach the server";
}

/** Per-message cap from the slice 4 freeze; the server enforces it again at send. */
const MAX_ATTACHMENTS_PER_MESSAGE = 32;

function retryable(failure: { error: string; status?: number } | { transport: true }): boolean {
  return "transport" in failure || failure.error === "unavailable" || failure.error === "rate_limited";
}
