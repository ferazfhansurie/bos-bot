// Durable cloud-room outbox (D04). Each send is frozen before its first
// transmission and persisted before any I/O; recovery only ever retries or
// looks up that same envelope under the same operation id.
import {
  canonicalJson,
  LIMITS,
  validMentions,
  type OperationResult,
  type SendEnvelope,
} from "../../shared/cloud-protocol/index";
import type { Sequence } from "./sequence";

type Namespace = SendEnvelope["namespace"];
type Mention = SendEnvelope["mentions"][number];

/** draft → sending → checking → accepted | rejected. Accepted proves cloud commit only. */
export type OutboxState = "draft" | "sending" | "checking" | "accepted" | "rejected";

export interface OutboxEntry {
  envelope: SendEnvelope;
  digest: string;
  state: OutboxState;
  created_at: number;
  /** Set and persisted before the first byte is sent; never cleared. */
  dispatched: boolean;
  attempts: number;
  retry_at?: number;
  /** Lookup returned not_found: the unchanged envelope may be sent again. */
  resend_allowed?: boolean;
  /** Lookup returned recovery_unknown: reconciliation only, never a fresh send. */
  recovery_required?: boolean;
  /** A never-dispatched draft that aged out needs explicit review first. */
  review_required?: boolean;
  /**
   * Frozen under an epoch the workspace has since left (authority_changed).
   * The envelope can never be sent; review re-freezes the text as a new send.
   */
  legacy_epoch?: string;
  message_id?: string;
  sequence?: Sequence;
  rejection?: string;
}

export type SendFailure = { error: string; retry_after?: number } | { transport: true };

export type OutboxAction =
  | { type: "queued"; entry: OutboxEntry }
  | { type: "restored"; now: number }
  | { type: "tick"; now: number }
  | { type: "review_confirmed"; id: string; now: number }
  | { type: "dispatching"; id: string }
  | { type: "send_failed"; id: string; now: number; failure: SendFailure }
  | { type: "lookup_failed"; id: string; now: number; retry_after?: number }
  | { type: "operation_result"; now: number; result: OperationResult }
  | { type: "stream_accepted"; operation_id: string; message_id: string; sequence: Sequence }
  | { type: "authority_changed"; workspace_id: string; epoch: string }
  | { type: "discard"; id: string };

const UNRESOLVED: ReadonlySet<OutboxState> = new Set(["draft", "sending", "checking"]);
const MAX_BACKOFF_MS = 30_000;
const DRAFT_REVIEW_AFTER_MS = 24 * 60 * 60 * 1000;
/** Error codes on a send that prove the operation was rejected, not lost. */
const REJECTING_ERRORS = new Set([
  "invalid_request",
  "forbidden",
  "operation_conflict",
  "operation_expired",
  "policy_changed",
  "invalid_mention",
  "unsupported_attachment",
  "invalid_reply",
]);

export function isUnresolved(entry: OutboxEntry): boolean {
  return UNRESOLVED.has(entry.state);
}

export function operationIdOf(entry: OutboxEntry): string {
  return entry.envelope.client_operation_id;
}

export type EnvelopeProblem = "text_empty" | "text_too_large" | "invalid_mention";

/** Validate exact text and selected mention spans before the operation is frozen. */
export function envelopeProblem(text: string, mentions: Mention[]): EnvelopeProblem | null {
  if (text.trim().length === 0) return "text_empty";
  if (new TextEncoder().encode(text).byteLength > LIMITS.textBytes) return "text_too_large";
  if (!validMentions(text, mentions)) return "invalid_mention";
  return null;
}

/** SHA-256 over the canonical JSON of the exact frozen envelope. */
export async function envelopeDigest(envelope: SendEnvelope): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(envelope)));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface NewSend {
  namespace: Namespace;
  window_id: string;
  window_token: string;
  room_id: string;
  thread_id: string;
  text: string;
  mentions: Mention[];
  /** Only attachments that finished verification (state ready). */
  attachment_ids?: string[];
  reply_to_message_id?: string | null;
  expected_policy_revision: Sequence;
  now: number;
  nonce?: string;
}

/** Freeze a send. Invalid text or spans keep the draft in the composer instead. */
export async function freezeSend(input: NewSend): Promise<OutboxEntry | { problem: EnvelopeProblem }> {
  const attachments = input.attachment_ids ?? [];
  // A message may be attachments only.
  const problem = attachments.length > 0 && input.text.trim().length === 0 ? null : envelopeProblem(input.text, input.mentions);
  if (problem) return { problem };
  const envelope: SendEnvelope = {
    kind: "message.send",
    namespace: { ...input.namespace },
    client_operation_id: `${input.window_id}.${input.nonce ?? randomNonce()}`,
    window_token: input.window_token,
    room_id: input.room_id,
    thread_id: input.thread_id,
    text: input.text,
    mentions: input.mentions.map((span) => ({ ...span })),
    attachment_ids: [...attachments],
    reply_to_message_id: input.reply_to_message_id ?? null,
    expected_policy_revision: input.expected_policy_revision,
  };
  return { envelope, digest: await envelopeDigest(envelope), state: "draft", created_at: input.now, dispatched: false, attempts: 0 };
}

/** Full-jitter exponential backoff, capped at 30s; Retry-After wins when longer. */
export function backoffMs(attempts: number, retryAfterMs = 0, random = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, 500 * 2 ** Math.min(attempts, 16));
  return Math.max(retryAfterMs, Math.floor(random() * ceiling));
}

function update(entries: OutboxEntry[], id: string, change: (entry: OutboxEntry) => OutboxEntry): OutboxEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (operationIdOf(entry) !== id) return entry;
    const updated = change(entry);
    if (updated !== entry) changed = true;
    return updated;
  });
  return changed ? next : entries;
}

const SETTLED: Partial<OutboxEntry> = { retry_at: undefined, resend_allowed: undefined, recovery_required: undefined };

function accept(entry: OutboxEntry, messageId: string, sequence: Sequence): OutboxEntry {
  if (entry.state === "accepted") return entry;
  return { ...entry, ...SETTLED, state: "accepted", message_id: messageId, sequence };
}

function reject(entry: OutboxEntry, reason: string): OutboxEntry {
  // A retained acceptance always wins over a later rejection report.
  if (entry.state === "accepted" || entry.state === "rejected") return entry;
  return { ...entry, ...SETTLED, state: "rejected", rejection: reason };
}

export function outboxReducer(entries: OutboxEntry[], action: OutboxAction): OutboxEntry[] {
  switch (action.type) {
    case "queued": {
      const id = operationIdOf(action.entry);
      if (!entries.some((entry) => operationIdOf(entry) === id)) return [...entries, action.entry];
      // A persisted state for the same frozen envelope replaces the old one.
      return entries.map((entry) => (operationIdOf(entry) === id ? { ...entry, ...action.entry, envelope: entry.envelope } : entry));
    }
    case "restored":
      // Anything that may have left the device before a crash is unknown, not unsent.
      return entries.map((entry) => (entry.state === "sending" && entry.dispatched ? { ...entry, state: "checking", retry_at: action.now } : entry));
    case "tick":
      return entries.map((entry) =>
        entry.state === "draft" && !entry.dispatched && !entry.review_required && action.now - entry.created_at > DRAFT_REVIEW_AFTER_MS
          ? { ...entry, review_required: true }
          : entry,
      );
    case "review_confirmed":
      // A legacy envelope stays held; only a re-freeze under the new epoch can send its text.
      return update(entries, action.id, (entry) =>
        entry.state === "draft" && entry.review_required && !entry.legacy_epoch ? { ...entry, review_required: false, created_at: action.now } : entry,
      );
    case "dispatching":
      return update(entries, action.id, (entry) => {
        const resend = entry.state === "checking" && entry.resend_allowed && !entry.recovery_required;
        if (entry.state !== "draft" && entry.state !== "sending" && !resend) return entry;
        return { ...entry, state: "sending", dispatched: true, attempts: entry.attempts + 1, retry_at: undefined, resend_allowed: undefined };
      });
    case "send_failed":
      return update(entries, action.id, (entry) => {
        if (entry.state !== "sending") return entry;
        const failure = action.failure;
        if ("error" in failure && REJECTING_ERRORS.has(failure.error)) return reject(entry, failure.error);
        // A structured 429 proves the request was not admitted: retry the same envelope.
        if ("error" in failure && failure.error === "rate_limited") {
          return { ...entry, retry_at: action.now + backoffMs(entry.attempts, (failure.retry_after ?? 0) * 1000) };
        }
        const recovery = "error" in failure && failure.error === "recovery_unknown";
        return { ...entry, state: "checking", retry_at: action.now, recovery_required: recovery || undefined };
      });
    case "lookup_failed":
      return update(entries, action.id, (entry) =>
        entry.state === "checking"
          ? { ...entry, attempts: entry.attempts + 1, retry_at: action.now + backoffMs(entry.attempts, (action.retry_after ?? 0) * 1000) }
          : entry,
      );
    case "operation_result":
      return update(entries, action.result.client_operation_id, (entry) => {
        if (entry.state !== "sending" && entry.state !== "checking") return entry;
        const result = action.result;
        if (result.status === "accepted") return accept(entry, result.message_id, result.sequence);
        if (result.status === "rejected") return reject(entry, result.reason);
        if (result.status === "not_found") {
          // not_found is not proof a delayed request cannot commit; stay checking and resend unchanged.
          return { ...entry, state: "checking", resend_allowed: true, recovery_required: undefined, retry_at: action.now };
        }
        return { ...entry, state: "checking", recovery_required: true, resend_allowed: undefined, attempts: entry.attempts + 1, retry_at: action.now + backoffMs(entry.attempts) };
      });
    case "stream_accepted":
      return update(entries, action.operation_id, (entry) => accept(entry, action.message_id, action.sequence));
    case "authority_changed": {
      // Never-sent drafts from the old epoch are kept for a human to review, never replayed.
      // Anything that may have left the device keeps reconciling by lookup as before.
      let changed = false;
      const next = entries.map((entry) => {
        const namespace = entry.envelope.namespace;
        if (namespace.workspace_id !== action.workspace_id || namespace.epoch === action.epoch) return entry;
        if (entry.state !== "draft" || entry.dispatched || entry.legacy_epoch !== undefined) return entry;
        changed = true;
        return { ...entry, review_required: true, legacy_epoch: namespace.epoch, retry_at: undefined };
      });
      return changed ? next : entries;
    }
    case "discard":
      // Only a never-sent draft or a terminal entry can leave the outbox.
      return entries.filter((entry) => {
        if (operationIdOf(entry) !== action.id) return true;
        return !((entry.state === "draft" && !entry.dispatched) || !isUnresolved(entry));
      });
  }
}

export type OutboxWork = { kind: "send" | "lookup"; entry: OutboxEntry };

/**
 * The next network step per room. Sends are sequential per room on this
 * device: a later entry waits until every earlier one is resolved.
 */
export function nextWork(entries: readonly OutboxEntry[], namespace: Namespace, now: number): OutboxWork[] {
  const blockedRooms = new Set<string>();
  const work: OutboxWork[] = [];
  for (const entry of entries) {
    // A legacy draft waits for review and never holds up the room's new sends.
    if (!isUnresolved(entry) || entry.legacy_epoch !== undefined) continue;
    const room = `${entry.envelope.namespace.workspace_id}/${entry.envelope.room_id}`;
    if (blockedRooms.has(room)) continue;
    blockedRooms.add(room);
    // Never send under a different identity than the one that froze the operation.
    if (!sameNamespace(entry.envelope.namespace, namespace, true)) continue;
    if (entry.retry_at !== undefined && entry.retry_at > now) continue;
    if (entry.state === "draft" && !entry.review_required) work.push({ kind: "send", entry });
    else if (entry.state === "sending" && entry.retry_at !== undefined) work.push({ kind: "send", entry });
    else if (entry.state === "checking" && entry.resend_allowed && !entry.recovery_required) work.push({ kind: "send", entry });
    else if (entry.state === "checking") work.push({ kind: "lookup", entry });
  }
  return work;
}

/** Same signed-in identity; with `anyWorkspace`, the workspace may differ. */
export function sameNamespace(a: Namespace, b: Namespace, anyWorkspace = false): boolean {
  return (
    a.service === b.service &&
    a.issuer === b.issuer &&
    a.subject === b.subject &&
    a.account_id === b.account_id &&
    (anyWorkspace || (a.workspace_id === b.workspace_id && a.epoch === b.epoch))
  );
}

/** User-visible label for an outbox entry. */
export function outboxLabel(entry: OutboxEntry): string {
  if (entry.state === "draft") return entry.legacy_epoch ? "not sent · written before this room moved" : entry.review_required ? "needs review" : "waiting";
  if (entry.state === "sending") return "sending";
  if (entry.state === "checking") return entry.recovery_required ? "can't confirm yet" : "checking whether sent";
  if (entry.state === "accepted") return "sent";
  return `not sent: ${entry.rejection ?? "rejected"}`;
}

export interface OutboxStore {
  load(): OutboxEntry[];
  save(entries: OutboxEntry[]): void;
}

/** Outbox storage is namespaced by issuer and account; another account never sees these sends. */
export function outboxStorageKey(namespace: Pick<Namespace, "service" | "issuer" | "subject">): string {
  return `bos.cloud.v1.outbox:${[namespace.service, namespace.issuer, namespace.subject].map(encodeURIComponent).join(":")}`;
}

export function localOutboxStore(storage: Pick<Storage, "getItem" | "setItem">, namespace: Namespace): OutboxStore {
  const key = outboxStorageKey(namespace);
  return {
    load() {
      try {
        const parsed = JSON.parse(storage.getItem(key) ?? "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return (parsed as OutboxEntry[]).filter((entry) => entry?.envelope?.namespace && sameNamespace(entry.envelope.namespace, namespace, true));
      } catch {
        return [];
      }
    },
    save(entries) {
      storage.setItem(key, JSON.stringify(entries));
    },
  };
}

/**
 * The signed operation window, kept with the outbox so a member can queue a
 * send while offline. It is actor- and epoch-bound; the server rechecks it.
 */
export interface WindowStore {
  load(): { window_id: string; window_token: string; expires_at: string; namespace: Namespace } | null;
  save(window: { window_id: string; window_token: string; expires_at: string; namespace: Namespace } | null): void;
}

export function localWindowStore(storage: Pick<Storage, "getItem" | "setItem">, namespace: Namespace): WindowStore {
  const key = `${outboxStorageKey(namespace).replace(".outbox:", ".window:")}:${encodeURIComponent(namespace.workspace_id)}`;
  return {
    load() {
      try {
        const parsed = JSON.parse(storage.getItem(key) ?? "null") as ReturnType<WindowStore["load"]>;
        return parsed?.namespace && sameNamespace(parsed.namespace, namespace, true) && parsed.namespace.workspace_id === namespace.workspace_id ? parsed : null;
      } catch {
        return null;
      }
    },
    save(window) {
      storage.setItem(key, JSON.stringify(window));
    },
  };
}

export function memoryWindowStore(): WindowStore {
  let saved: ReturnType<WindowStore["load"]> = null;
  return {
    load: () => saved,
    save(window) {
      saved = window;
    },
  };
}

/** Guest content and drafts live in session memory only. */
export function memoryOutboxStore(): OutboxStore {
  let saved: OutboxEntry[] = [];
  return {
    load: () => saved,
    save(entries) {
      saved = entries;
    },
  };
}
