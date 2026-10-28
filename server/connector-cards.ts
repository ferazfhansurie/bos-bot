// The words and the dedupe rule for an in-chat connector card, kept out of
// index.ts so they can be tested on their own.
import type { ConnectorCardData } from "../shared/wire.ts";

export const CONNECT_REASON_MAX = 140;

/** The bot's one line on why it needs the app, made safe to show: one line,
 * no control characters, bounded, and reading after "<bot> needs <app>". */
export function connectReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  line = line.replace(/[.\s]+$/, "");
  if (!line) return undefined;
  if (line.length > CONNECT_REASON_MAX) line = `${line.slice(0, CONNECT_REASON_MAX - 1).trimEnd()}…`;
  // "So I can…" → "so I can…", but leave "API…" or "iCloud…" alone
  if (/^[A-Z][a-z]/.test(line)) line = line[0].toLowerCase() + line.slice(1);
  return line;
}

export function connectorCardDescription(input: {
  label: string;
  blurb?: string;
  alias?: string;
  botName?: string;
  reason?: string;
  reconnect?: boolean;
}): string {
  if (input.reconnect) return `${input.label} needs signing in again`;
  if (input.alias) return `Connect ${input.label} as “${input.alias}” so the bot can continue`;
  if (input.reason) return `${input.botName?.trim() || "Your bot"} needs ${input.label} ${input.reason}`;
  return input.blurb || `Connect ${input.label} so the bot can continue`;
}

/** An open reconnect card for this app already in the thread: the bridge
 * gets that one back instead of a second card, until it is connected or the
 * person dismisses it. */
export function openReconnectCard<M extends { id: string; kind?: string; connector?: ConnectorCardData }>(
  messages: readonly M[],
  slug: string,
): M | undefined {
  return messages.findLast((message) =>
    message.kind === "connector" && message.connector?.reconnect === true && message.connector.slug === slug
    && !message.connector.alias && !message.connector.dismissed && message.connector.status !== "connected");
}
