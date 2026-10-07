// HTTP and realtime transport for the /v2 cloud room service. Native clients
// send the issuer bearer; the web client sends nothing and relies on the
// same-site session cookie. The server derives the actor and membership.
import {
  FrameSchema,
  LIMITS,
  LookupSchema,
  SnapshotSchema,
  type CloudFrame,
  type CloudMessage,
  type CloudSnapshot,
  type OperationResult,
  type ReadCoverage,
  type SendEnvelope,
} from "../../shared/cloud-protocol/index";
import { identityProblem, type IdentityProblem } from "./auth-state";

export interface CloudIdentity {
  account_id: string;
  issuer: string;
  subject: string;
  service: string;
}

export interface CloudSession extends CloudIdentity {
  baseUrl: string;
  /** Null on the web: the issuer's protected cookie authenticates instead. */
  bearer: string | null;
}

export type CloudFailure = { error: string; status: number; retry_after?: number } | { transport: true; status?: number };

export type CloudResult<T> = { ok: true; value: T } | { ok: false; failure: CloudFailure };

export interface OperationWindow {
  namespace: SendEnvelope["namespace"];
  window_id: string;
  window_token: string;
  issued_at: string;
  expires_at: string;
}

export interface SyncRoom {
  room_id: string;
  thread_id: string;
  policy_revision: string;
}

export interface SyncWorkspace {
  workspace_id: string;
  role: string;
  rooms: SyncRoom[];
}

async function request<T>(baseUrl: string, bearer: string | null, method: string, path: string, body?: unknown): Promise<CloudResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIMITS.requestMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      method,
      credentials: "same-origin",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const parsed = (await response.json().catch(() => null)) as unknown;
    if (response.ok) return { ok: true, value: parsed as T };
    const error = (parsed as { error?: unknown; retry_after?: unknown } | null) ?? {};
    if (typeof error.error === "string") {
      return { ok: false, failure: { error: error.error, status: response.status, retry_after: typeof error.retry_after === "number" ? error.retry_after : undefined } };
    }
    return { ok: false, failure: { transport: true, status: response.status } };
  } catch {
    // Timeouts and network loss prove nothing about whether the server committed.
    return { ok: false, failure: { transport: true } };
  } finally {
    clearTimeout(timer);
  }
}

const enc = encodeURIComponent;

/** Who the room service says is signed in, validated fresh against the issuer. */
export async function currentSession(baseUrl: string, bearer: string | null): Promise<CloudResult<CloudSession>> {
  const result = await request<CloudIdentity>(baseUrl, bearer, "GET", "/v2/me");
  if (!result.ok) return result;
  return { ok: true, value: { ...result.value, baseUrl, bearer } };
}

/** `onIdentity` hears every identity failure, and `null` after any success. */
export function cloudApi(session: CloudSession, onIdentity: (problem: IdentityProblem | null) => void = () => {}) {
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const result = await request<T>(session.baseUrl, session.bearer, method, path, body);
    if (result.ok) onIdentity(null);
    else {
      const problem = identityProblem(result.failure);
      if (problem) onIdentity(problem);
    }
    return result;
  };
  return {
    me: () => call<CloudIdentity>("GET", "/v2/me"),
    sync: () => call<{ workspaces: SyncWorkspace[] }>("GET", "/v2/discovery/sync"),
    createWorkspace: (name: string) => call<{ workspace_id: string; role: string }>("POST", "/v2/workspaces", { name }),
    createRoom: (workspaceId: string, name: string) => call<SyncRoom>("POST", `/v2/workspaces/${enc(workspaceId)}/rooms`, { name }),
    createInvite: (workspaceId: string, input: { role: string; room_ids: string[]; subject?: string }) =>
      call<{ invite_id: string; token: string; expires_at: string }>("POST", `/v2/workspaces/${enc(workspaceId)}/invites`, input),
    redeemInvite: (token: string) => call<{ workspace_id: string; role: string; room_ids: string[] }>("POST", "/v2/invites/redeem", { token }),
    openWindow: (workspaceId: string) => call<OperationWindow>("POST", `/v2/workspaces/${enc(workspaceId)}/operation-windows`, {}),
    send: async (envelope: SendEnvelope): Promise<CloudResult<OperationResult>> => {
      const result = await call<unknown>("POST", `/v2/workspaces/${enc(envelope.namespace.workspace_id)}/messages`, envelope);
      if (!result.ok) return result;
      const parsed = LookupSchema.safeParse(result.value);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: { transport: true } };
    },
    lookup: async (workspaceId: string, operationId: string): Promise<CloudResult<OperationResult>> => {
      const result = await call<unknown>("GET", `/v2/workspaces/${enc(workspaceId)}/operations/${enc(operationId)}`);
      if (!result.ok) return result;
      const parsed = LookupSchema.safeParse(result.value);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: { transport: true } };
    },
    snapshot: async (workspaceId: string, roomId: string, threadId: string): Promise<CloudResult<CloudSnapshot>> => {
      const result = await call<unknown>("POST", `/v2/workspaces/${enc(workspaceId)}/rooms/${enc(roomId)}/snapshot`, { thread_id: threadId });
      if (!result.ok) return result;
      const parsed = SnapshotSchema.safeParse(result.value);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, failure: { transport: true } };
    },
    history: (workspaceId: string, roomId: string, threadId: string, before: string) =>
      call<{ messages: CloudMessage[]; next_before: string | null }>(
        "GET",
        `/v2/workspaces/${enc(workspaceId)}/rooms/${enc(roomId)}/history?thread_id=${enc(threadId)}&before=${enc(before)}&limit=${LIMITS.historyMessages}`,
      ),
    postRead: (workspaceId: string, roomId: string, body: { thread_id: string; intervals: Array<[string, string]>; mark_read_through?: string }) =>
      call<ReadCoverage>("POST", `/v2/workspaces/${enc(workspaceId)}/rooms/${enc(roomId)}/read`, body),
  };
}

export type CloudApi = ReturnType<typeof cloudApi>;

export interface RealtimeHandlers {
  onOpen(): void;
  onFrame(frame: CloudFrame, bytes: number): void;
  onClose(reason: "closed" | "invalid_frame"): void;
}

export interface RealtimeConnection {
  subscribe(input: { workspace_id: string; room_id: string; thread_id: string; cursor: string | null; snapshot_id?: string }): void;
  close(): void;
}

/**
 * Open the realtime socket. A native bearer goes in the first frame, never the
 * URL; on the web the frame carries no bearer and the upgrade's cookie counts.
 */
export function connectRealtime(session: CloudSession, handlers: RealtimeHandlers, Socket: typeof WebSocket = WebSocket): RealtimeConnection {
  const url = `${session.baseUrl.replace(/^http/, "ws").replace(/\/$/, "")}/v2/realtime`;
  const socket = new Socket(url);
  let closed = false;
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify(session.bearer ? { type: "authenticate", bearer: session.bearer } : { type: "authenticate" }));
    handlers.onOpen();
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    const raw = typeof event.data === "string" ? event.data : "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const frame = FrameSchema.safeParse(parsed);
    if (!frame.success) {
      closed = true;
      socket.close();
      handlers.onClose("invalid_frame");
      return;
    }
    handlers.onFrame(frame.data, raw.length);
  });
  socket.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    handlers.onClose("closed");
  });
  return {
    subscribe(input) {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "subscribe", ...input }));
    },
    close() {
      closed = true;
      socket.close();
    },
  };
}
