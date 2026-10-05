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
  /** the whole serialized WhatsApp Web model (whatsapp-web.js Message#_data);
   * interactive messages keep their visible text only here */
  _data?: unknown;
  title?: unknown;
  description?: unknown;
  dynamicReplyButtons?: unknown;
  selectedButtonId?: unknown;
  selectedRowId?: unknown;
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

/** Messages whose visible text is a reply to buttons, a list or a template. */
const REPLY_TYPES = new Set(["buttons_response", "list_response", "template_button_reply", "interactive_response"]);
/** Messages that carry header/body/footer text and buttons outside `body`. */
const INTERACTIVE_TYPES = new Set(["buttons", "list", "template", "hsm", "interactive", "native_flow", "product_list"]);
/** Fields whose presence marks a message as interactive whatever its type
 * (a buttons message can arrive typed "chat" or "image"). */
const INTERACTIVE_FIELDS = [
  "dynamicReplyButtons",
  "replyButtons",
  "hydratedButtons",
  "templateButtons",
  "list",
  "interactiveHeader",
  "interactiveBody",
  "interactiveFooter",
  "interactivePayload",
  "nativeFlowButtons",
] as const;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** value at a dotted path through plain records */
function at(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    const next = record(current);
    if (!next) return undefined;
    current = next[key];
  }
  return current;
}

function firstText(source: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    const found = text(at(source, path));
    if (found) return found;
  }
  return null;
}

/** A button's visible label across the shapes WhatsApp Web has used: reply
 * buttons, hydrated template buttons and native-flow buttons. */
function buttonLabel(button: unknown): string | null {
  if (typeof button === "string") return text(button);
  const label = firstText(button, [
    "buttonText.displayText",
    "buttonText",
    "displayText",
    "quickReplyButton.displayText",
    "urlButton.displayText",
    "callButton.displayText",
    "title",
    "body",
  ]);
  if (label) return label;
  const params = text(at(button, "buttonParamsJson"));
  if (!params) return null;
  try {
    const parsed: unknown = JSON.parse(params);
    return firstText(parsed, ["display_text", "title"]);
  } catch {
    return null;
  }
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  // a serialized Backbone collection keeps its items under _models / models
  const items = record(value)?._models ?? record(value)?.models;
  return Array.isArray(items) ? items : [];
}

/** set and not empty: an empty array or record does not make a message interactive */
function present(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const fields = record(value);
  if (fields) return Object.keys(fields).length > 0;
  return value !== undefined && value !== null && value !== false && value !== "";
}

function unique(parts: (string | null)[]): string[] {
  const seen = new Set<string>();
  return parts.filter((part): part is string => {
    if (!part || seen.has(part)) return false;
    seen.add(part);
    return true;
  });
}

/** The text a person sees on an interactive message or a reply to one, for
 * messages whose `body` is empty or incomplete; null for everything else. */
export function interactiveBody(raw: RawCaptureFields): string | null {
  const data = record(raw._data) ?? {};
  const type = String(raw.type ?? data.type ?? "");
  const body = text(raw.body) ?? text(data.body);

  if (REPLY_TYPES.has(type) || present(raw.selectedButtonId) || present(raw.selectedRowId) || present(data.selectedButtonId) || present(data.listResponse)) {
    // the selected button / row as displayed, then whatever body there is,
    // then the bare id (better than an empty row)
    return firstText(data, [
      "selectedButtonDisplayText",
      "selectedDisplayText",
      "buttonsResponse.selectedDisplayText",
      "templateButtonReply.selectedDisplayText",
      "listResponse.title",
      "interactiveResponseBody.text",
      "interactiveResponseMessage.body.text",
      "nativeFlowResponseBody.text",
    ]) ?? body ?? firstText(data, ["listResponse.description"]) ?? text(raw.selectedButtonId) ?? text(raw.selectedRowId)
      ?? firstText(data, ["selectedButtonId", "selectedId", "listResponse.singleSelectReply.selectedRowId"]);
  }

  const interactive = INTERACTIVE_TYPES.has(type) || present(raw.dynamicReplyButtons) ||
    data.isDynamicReplyButtonsMsg === true || data.isFromTemplate === true ||
    INTERACTIVE_FIELDS.some((field) => present(data[field]));
  if (!interactive) return null;

  const header = [text(raw.title), firstText(data, ["title", "list.title", "hydratedTitleText", "headerText", "interactiveHeader.title", "header.title"])];
  const main = [
    body,
    firstText(data, ["caption", "list.description", "hydratedContentText", "contentText", "interactiveBody.text"]),
    text(raw.description) ?? text(data.description),
  ];
  const footer = [firstText(data, ["footer", "footerText", "list.footerText", "hydratedFooterText", "interactiveFooter.text"])];
  const buttons = [
    raw.dynamicReplyButtons,
    data.dynamicReplyButtons,
    data.replyButtons,
    data.buttons,
    data.hydratedButtons,
    data.templateButtons,
    at(data, "interactivePayload.buttons"),
    data.nativeFlowButtons,
  ].flatMap((value) => listOf(value).map(buttonLabel));
  const list = [
    firstText(data, ["list.buttonText"]),
    ...listOf(at(data, "list.sections")).flatMap((section) => listOf(at(section, "rows")).map((row) => firstText(row, ["title"]))),
  ];
  const visible = unique([...header, ...main, ...footer, ...buttons, ...list]);
  return visible.length ? visible.join("\n") : null;
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
      body: interactiveBody(raw) ?? (typeof raw.body === "string" ? raw.body : ""),
      hasMedia: raw.hasMedia === true,
    },
  };
}
