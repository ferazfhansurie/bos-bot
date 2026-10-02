// Turns the plain fields of a whatsapp-web.js message into a CapturedMessage,
// or says why it was skipped. No whatsapp-web.js import, so it is tested
// directly (whatsapp-capture.test.ts) and the wrapper stays a thin shell.
import type { CapturedMessage } from "./whatsapp-types.ts";

/** WhatsApp Status updates are not conversations; they are not captured. */
export const STATUS_BROADCAST = "status@broadcast";

/** The fields capture reads. Everything is unknown: WhatsApp Web changes its
 * serialized shapes without notice. */
export interface RawCaptureFields {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  author?: unknown;
  fromMe?: unknown;
  timestamp?: unknown;
  type?: unknown;
  body?: unknown;
  hasMedia?: unknown;
}

export type CaptureFields =
  | { skip: null; message: Omit<CapturedMessage, "chatId" | "chatName">; fallbackChatId: string }
  | { skip: string; expected: boolean };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** A Wid as a string: already a string, or `{ _serialized }`, or rebuilt as
 * `<user>@<server>` when `_serialized` is gone. */
export function serializedWid(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  const wid = record(value);
  if (!wid) return null;
  if (typeof wid._serialized === "string" && wid._serialized) return wid._serialized;
  if (typeof wid.user === "string" && typeof wid.server === "string" && wid.user && wid.server) return `${wid.user}@${wid.server}`;
  return null;
}

/** The serialized message key, `<fromMe>_<remote>_<id>[_<participant>]`.
 * WhatsApp Web 2.3000.1049x stopped keeping `_serialized` on the serialized
 * key (it comes back under a minified name), so it is rebuilt from the parts
 * in the same form whatsapp-web.js has always used. */
export function serializedMessageId(key: unknown): string | null {
  if (typeof key === "string") return key || null;
  const parts = record(key);
  if (!parts) return null;
  if (typeof parts._serialized === "string" && parts._serialized) return parts._serialized;
  const remote = serializedWid(parts.remote);
  const id = typeof parts.id === "string" && parts.id ? parts.id : null;
  if (typeof parts.fromMe !== "boolean" || !remote || !id) return null;
  const participant = serializedWid(parts.participant);
  return `${parts.fromMe}_${remote}_${id}${participant ? `_${participant}` : ""}`;
}

export function captureFields(raw: RawCaptureFields): CaptureFields {
  const id = serializedMessageId(raw.id);
  if (!id) return { skip: "the message has no readable id", expected: false };
  const from = serializedWid(raw.from);
  const to = serializedWid(raw.to);
  if (from === STATUS_BROADCAST || to === STATUS_BROADCAST) return { skip: "status update", expected: true };
  const fromMe = raw.fromMe === true;
  const fallbackChatId = fromMe ? to : from;
  if (!fallbackChatId) return { skip: "the message has no readable chat id", expected: false };
  return {
    skip: null,
    fallbackChatId,
    message: {
      id,
      from: from ?? "",
      author: serializedWid(raw.author),
      fromMe,
      timestamp: Number(raw.timestamp) || Math.floor(Date.now() / 1000),
      type: String(raw.type ?? "unknown"),
      body: typeof raw.body === "string" ? raw.body : "",
      hasMedia: raw.hasMedia === true,
    },
  };
}
