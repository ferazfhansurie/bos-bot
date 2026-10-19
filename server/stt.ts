// Speech to text for voice messages. This home never holds a transcription
// provider key: it posts audio to an operator-run relay (config `stt`) that
// owns the keys, the retries across providers, chunking and rate limits.
// Here we only keep a short in-memory memo so the composer's transcript and
// the turn's automatic one never pay for the same audio twice.
import { readFile, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import type { AppConfig } from "./config.ts";
import { ATTACHMENTS_DIR } from "./attachments.ts";

/** Audio the relay accepts, by the extension saveFile gave it. */
const AUDIO_MIMES: Readonly<Record<string, string>> = {
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".oga": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
};

/** Above this a voice note is not a voice note; the relay caps lower. */
export const STT_MAX_BYTES = 60 * 1024 * 1024;

export interface SttResult {
  text: string;
  language?: string;
  provider?: string;
  durationSec?: number;
}

export class SttError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export function sttConfigured(cfg: AppConfig): boolean {
  return Boolean(cfg.stt?.relayUrl?.trim() && cfg.stt?.token?.trim());
}

export function sttAutoTranscribe(cfg: AppConfig): boolean {
  return sttConfigured(cfg) && cfg.stt?.autoTranscribe !== false;
}

export function audioMimeForPath(path: string): string | null {
  return AUDIO_MIMES[extname(path).toLowerCase()] ?? null;
}

/** An uploaded audio attachment of this home, or null. The path comes from a
 * client or a message, so it is resolved and must stay a direct child of the
 * attachments folder: no traversal, no other files on this machine. */
export function attachmentAudioPath(path: string, dir: string = ATTACHMENTS_DIR): string | null {
  if (typeof path !== "string" || !path || path.length > 4096) return null;
  const root = resolve(dir);
  const full = resolve(path);
  if (!full.startsWith(root + sep) || full.slice(root.length + 1).includes(sep)) return null;
  if (!/^[\w.-]+$/.test(basename(full))) return null;
  return audioMimeForPath(full) ? full : null;
}

interface Memo { key: string; result: SttResult; at: number }
const MEMO_MAX = 200;
const memo = new Map<string, Memo>();
const inflight = new Map<string, Promise<SttResult>>();
/** Paths the composer already turned into the message's own text. */
const composerTranscribed = new Set<string>();

function remember(path: string, key: string, result: SttResult): void {
  memo.delete(path);
  memo.set(path, { key, result, at: Date.now() });
  while (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
}

export function cachedTranscript(path: string): SttResult | null {
  return memo.get(resolve(path))?.result ?? null;
}

export function markComposerTranscribed(path: string): void {
  composerTranscribed.add(resolve(path));
  while (composerTranscribed.size > MEMO_MAX) composerTranscribed.delete(composerTranscribed.values().next().value!);
}

export function __resetSttForTests(): void {
  memo.clear();
  inflight.clear();
  composerTranscribed.clear();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Fetch = typeof fetch;

/** One relay call with retries for what retrying can fix: the network, a
 * 429, a 5xx. A 4xx is the audio's fault and is final. */
async function callRelay(cfg: AppConfig, bytes: Buffer, mime: string, name: string, opts: { timeoutMs: number; attempts: number; fetchImpl?: Fetch }): Promise<SttResult> {
  const base = cfg.stt!.relayUrl!.trim().replace(/\/+$/, "");
  const url = `${base}/transcribe?name=${encodeURIComponent(name)}`;
  const doFetch = opts.fetchImpl ?? fetch;
  let last: SttError = new SttError("speech relay unreachable", 502);
  for (let attempt = 0; attempt < opts.attempts; attempt++) {
    if (attempt > 0) await sleep(attempt === 1 ? 800 : 2500);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.stt!.token!.trim()}`, "content-type": mime },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (res.ok && typeof body.text === "string") {
        return {
          text: body.text.trim(),
          ...(typeof body.language === "string" ? { language: body.language } : {}),
          ...(typeof body.provider === "string" ? { provider: body.provider } : {}),
          ...(typeof body.duration === "number" ? { durationSec: body.duration } : {}),
        };
      }
      const message = typeof body.error === "string" ? body.error : `speech relay answered ${res.status}`;
      last = new SttError(message, res.status >= 500 || res.status === 429 ? 502 : res.status === 413 ? 413 : 422);
      if (res.status < 500 && res.status !== 429 && res.status !== 408) throw last;
    } catch (error) {
      if (error instanceof SttError && error.status !== 502) throw error;
      if (!(error instanceof SttError)) last = new SttError("speech relay unreachable", 502);
    }
  }
  throw last;
}

/** Transcribe one attachment. Same file, same answer: memoized by path plus
 * size and mtime, and concurrent callers share one relay call. */
export async function transcribeAttachment(cfg: AppConfig, path: string, opts: { timeoutMs?: number; attempts?: number; fetchImpl?: Fetch; dir?: string } = {}): Promise<SttResult> {
  if (!sttConfigured(cfg)) throw new SttError("speech to text is not set up on this workspace", 503);
  const full = attachmentAudioPath(path, opts.dir);
  if (!full) throw new SttError("not an audio attachment", 400);
  let info;
  try {
    info = await stat(full);
  } catch {
    throw new SttError("audio not found", 404);
  }
  if (!info.isFile()) throw new SttError("audio not found", 404);
  if (info.size === 0) throw new SttError("the recording is empty", 422);
  if (info.size > STT_MAX_BYTES) throw new SttError("the recording is too long to transcribe", 413);
  const key = `${info.size}:${info.mtimeMs}`;
  const hit = memo.get(full);
  if (hit && hit.key === key) return hit.result;
  const running = inflight.get(full);
  if (running) return running;
  const job = (async () => {
    const bytes = await readFile(full);
    const result = await callRelay(cfg, bytes, audioMimeForPath(full)!, basename(full), {
      timeoutMs: opts.timeoutMs ?? 240_000,
      attempts: opts.attempts ?? 3,
      fetchImpl: opts.fetchImpl,
    });
    remember(full, key, result);
    return result;
  })();
  inflight.set(full, job);
  try {
    return await job;
  } finally {
    inflight.delete(full);
  }
}

const FILE_TAG = /^<attached-file[\t ]+path="([^"\r\n]*)"(?:[\t ]+name="([^"\r\n]*)")?[\t ]*\/>$/gm;

const unescapeAttribute = (value: string) => value
  .replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">")
  .replaceAll("&#9;", "\t").replaceAll("&#13;", "\r").replaceAll("&#10;", "\n").replaceAll("&amp;", "&");

const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttr = (value: string) => escapeText(value).replaceAll('"', "&quot;");

/** Audio attachments in a message that still need a transcript for the
 * model: not the composer's own recording whose words are the text. */
export function pendingVoiceAttachments(text: string, dir: string = ATTACHMENTS_DIR): Array<{ path: string; name: string }> {
  const out: Array<{ path: string; name: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(FILE_TAG)) {
    const full = attachmentAudioPath(unescapeAttribute(match[1]!), dir);
    if (!full || seen.has(full)) continue;
    seen.add(full);
    if (composerTranscribed.has(full)) continue;
    const known = memo.get(full)?.result.text;
    if (known && text.includes(known)) continue;
    out.push({ path: full, name: unescapeAttribute(match[2] ?? basename(full)) });
  }
  return out.slice(0, 8);
}

/** The model-facing text with a transcript block after the message for every
 * voice note it carries. The stored message never changes. A failure becomes
 * a plain line, so the bot says it could not hear the note instead of
 * guessing. Bounded: a turn waits at most `budgetMs` for all of them. */
export async function withVoiceTranscripts(cfg: AppConfig, text: string, opts: { budgetMs?: number; fetchImpl?: Fetch; dir?: string } = {}): Promise<string> {
  if (!sttAutoTranscribe(cfg) || !text.includes("<attached-file")) return text;
  const pending = pendingVoiceAttachments(text, opts.dir);
  if (!pending.length) return text;
  const budgetMs = opts.budgetMs ?? 180_000;
  const blocks = await Promise.all(pending.map(async ({ path, name }) => {
    try {
      const result = await Promise.race([
        transcribeAttachment(cfg, path, { timeoutMs: budgetMs, fetchImpl: opts.fetchImpl, dir: opts.dir }),
        sleep(budgetMs).then(() => { throw new SttError("timed out", 504); }),
      ]);
      const language = result.language ? ` language="${escapeAttr(result.language)}"` : "";
      return `<voice-transcript name="${escapeAttr(name)}"${language}>\n${escapeText(result.text || "(no speech)")}\n</voice-transcript>`;
    } catch (error) {
      const reason = error instanceof SttError ? error.message : "transcription failed";
      return `<voice-transcript name="${escapeAttr(name)}" status="unavailable">automatic transcription failed (${escapeText(reason)}); tell the user you could not hear this voice note</voice-transcript>`;
    }
  }));
  return `${text}\n\n${blocks.join("\n\n")}`;
}
