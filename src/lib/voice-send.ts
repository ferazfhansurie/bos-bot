// Delivering a browser voice message without ever losing it. The recording
// is written to IndexedDB the moment it stops and leaves only when the
// server has accepted the message. Upload, then transcript, then send; each
// step is retried, each result is kept, so a retry (or the next page load)
// resumes where it stopped instead of starting over:
//   - the upload id is fixed, so a lost upload response cannot duplicate it
//   - transcription failing after retries still sends the audio, with a
//     short marker; the server transcribes attached audio for the bot itself
//   - only an upload or send failure leaves it here, shown with retry.
import { useSyncExternalStore } from "react";
import { composeMessage, fileAttachment, fileAttachmentFromFile, newAttachmentUploadId } from "./composer-attachments";
import { t } from "./i18n";

export interface VoiceTarget {
  botId?: string;
  groupId?: string;
  threadId: string;
  mode?: "chat" | "goal";
  replyToId?: string;
}

export type VoiceStage = "uploading" | "transcribing" | "sending" | "failed";

export interface PendingVoice {
  id: string;
  draftId: string;
  target: VoiceTarget;
  blob: Blob;
  mime: string;
  name: string;
  durationMs: number;
  uploadId: string;
  sendId: string;
  createdAt: number;
  stage: VoiceStage;
  error?: string;
  attachment?: { path: string; name: string; size: number };
  transcript?: { text: string; failed?: boolean };
}

type SendAction =
  | { type: "send"; botId: string; text: string; sendId: string; replyToId?: string; threadId: string; onError: () => void; onSent: () => void }
  | { type: "sendGroup"; groupId: string; text: string; sendId: string; replyToId?: string; threadId: string; mode?: "chat" | "goal"; onError: () => void; onSent: () => void };

export type VoiceDispatch = (action: SendAction) => void;

// ── storage ─────────────────────────────────────────────────────────────

const DB_NAME = "bos-voice-messages";
const STORE = "pending";
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === "undefined") return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

/** Private mode or a full disk: memory still holds it for this page. */
const persist = (entry: PendingVoice) => idb("readwrite", (store) => { store.put(entry); });
const forget = (id: string) => idb("readwrite", (store) => { store.delete(id); });

// ── live list ───────────────────────────────────────────────────────────

let entries: PendingVoice[] = [];
const listeners = new Set<() => void>();
const running = new Set<string>();
let restored = false;

function publish(next: PendingVoice[]): void {
  entries = next;
  for (const listener of listeners) listener();
}

function update(id: string, patch: Partial<PendingVoice>): PendingVoice | undefined {
  let changed: PendingVoice | undefined;
  publish(entries.map((entry) => (entry.id === id ? (changed = { ...entry, ...patch }) : entry)));
  return changed;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Recordings a previous page load never finished: shown as unsent, for
 * the person to retry or discard. Never re-sent without being asked. */
export async function restorePendingVoice(): Promise<void> {
  if (restored) return;
  restored = true;
  const saved = await idb<PendingVoice[]>("readonly", (store) => store.getAll() as IDBRequest<PendingVoice[]>);
  if (!saved?.length) return;
  const known = new Set(entries.map((entry) => entry.id));
  const resumed = saved
    .filter((entry) => !known.has(entry.id) && entry.blob instanceof Blob)
    .map((entry) => ({ ...entry, stage: "failed" as const, error: entry.error ?? t("composer.voice.interrupted") }));
  if (resumed.length) publish([...entries, ...resumed]);
}

export function usePendingVoice(draftId: string): PendingVoice[] {
  const all = useSyncExternalStore(subscribe, () => entries, () => entries);
  return all.filter((entry) => entry.draftId === draftId);
}

export function discardPendingVoice(id: string): void {
  if (running.has(id)) return;
  publish(entries.filter((entry) => entry.id !== id));
  void forget(id);
}

// ── delivery ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function attempt<T>(tries: number, run: () => Promise<T>, final: (error: unknown) => boolean = () => false): Promise<T> {
  let last: unknown;
  for (let index = 0; index < tries; index += 1) {
    if (index > 0) await sleep(index === 1 ? 1200 : 4000);
    try {
      return await run();
    } catch (error) {
      last = error;
      if (final(error)) break;
    }
  }
  throw last;
}

const statusOf = (error: unknown) =>
  typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : 0;
const refused = (error: unknown) => {
  const status = statusOf(error);
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
};

async function transcribe(path: string): Promise<{ text: string }> {
  const response = await fetch("/api/stt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
    signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  const body = (await response.json().catch(() => ({}))) as { text?: unknown; error?: unknown };
  if (!response.ok || typeof body.text !== "string") {
    throw Object.assign(new Error(typeof body.error === "string" ? body.error : "transcription failed"), { status: response.status });
  }
  return { text: body.text };
}

/** Run (or resume) one voice message to the server. Safe to call again on
 * an entry that failed; a second call while it runs is ignored. */
export async function deliverVoice(id: string, dispatch: VoiceDispatch): Promise<void> {
  if (running.has(id)) return;
  let entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return;
  running.add(id);
  try {
    if (!entry.attachment) {
      entry = update(id, { stage: "uploading", error: undefined })!;
      const file = new File([entry.blob], entry.name, { type: entry.mime });
      const uploadId = entry.uploadId;
      const saved = await attempt(3, async () => {
        const attachment = await fileAttachmentFromFile(file, uploadId);
        if (!attachment) throw Object.assign(new Error("this recording format is not accepted"), { status: 415 });
        return attachment;
      }, refused).catch((error) => {
        throw new Error(t("composer.voice.uploadFailed", { reason: error instanceof Error ? error.message : String(error) }));
      });
      entry = update(id, { attachment: { path: saved.path, name: saved.name, size: saved.size } })!;
      void persist(entry);
    }
    if (!entry.transcript) {
      entry = update(id, { stage: "transcribing", error: undefined })!;
      const path = entry.attachment!.path;
      const transcript = await attempt(3, () => transcribe(path), (error) => refused(error) || statusOf(error) === 503)
        .then(({ text }) => ({ text: text.trim() || t("composer.voice.noSpeech") }))
        .catch(() => ({ text: t("composer.voice.transcriptFailed"), failed: true }));
      entry = update(id, { transcript })!;
      void persist(entry);
    }
    entry = update(id, { stage: "sending", error: undefined })!;
    const { attachment, transcript, target, sendId } = entry;
    const text = composeMessage(transcript!.text, [fileAttachment(attachment!.name, attachment!.path, attachment!.size)]);
    await new Promise<void>((resolve, reject) => {
      const done = { onSent: () => resolve(), onError: () => reject(new Error(t("composer.voice.sendFailed"))) };
      if (target.groupId) {
        dispatch({ type: "sendGroup", groupId: target.groupId, text, sendId, replyToId: target.replyToId, threadId: target.threadId, mode: target.mode, ...done });
      } else if (target.botId) {
        dispatch({ type: "send", botId: target.botId, text, sendId, replyToId: target.replyToId, threadId: target.threadId, ...done });
      } else {
        reject(new Error(t("composer.voice.sendFailed")));
      }
    });
    publish(entries.filter((candidate) => candidate.id !== id));
    void forget(id);
  } catch (error) {
    const failed = update(id, { stage: "failed", error: error instanceof Error ? error.message : String(error) });
    if (failed) void persist(failed);
  } finally {
    running.delete(id);
  }
}

/** Keep a finished recording (memory and IndexedDB) and start delivering it. */
export async function queueVoiceMessage(
  input: { draftId: string; target: VoiceTarget; blob: Blob; mime: string; extension: string; durationMs: number; hold?: string },
  dispatch: VoiceDispatch,
): Promise<string> {
  const id = newAttachmentUploadId();
  const stamp = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const name = `Voice message ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}.${pad(stamp.getMinutes())}.${pad(stamp.getSeconds())}.${input.extension}`;
  const entry: PendingVoice = {
    id,
    draftId: input.draftId,
    target: input.target,
    blob: input.blob,
    mime: input.mime,
    name,
    durationMs: input.durationMs,
    uploadId: newAttachmentUploadId(),
    sendId: newAttachmentUploadId(),
    createdAt: Date.now(),
    // held: kept unsent with the reason, for the person to send or discard
    stage: input.hold ? "failed" : "uploading",
    ...(input.hold ? { error: input.hold } : {}),
  };
  publish([...entries, entry]);
  await persist(entry);
  if (!input.hold) void deliverVoice(id, dispatch);
  return id;
}

export function __resetVoiceSendForTests(): void {
  entries = [];
  running.clear();
  restored = false;
  dbPromise = null;
  listeners.clear();
}
