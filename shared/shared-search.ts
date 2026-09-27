import { contactId, parseContactId, type SharedTextMessage } from "./multiplayer.ts";

import { sharedSearchKinds, type SharedSearchKind } from "./shared-search-kinds.ts";
export type { SharedSearchKind } from "./shared-search-kinds.ts";
export interface SharedSearchOptions { query?: string; kind?: SharedSearchKind; author?: string; before?: number; limit?: number }
export interface SharedSearchPage { messages: SharedTextMessage[]; hasMore: boolean; before: number | null }

/** Search only a caller-authorized room. Cursors use immutable message sequence. */
export function searchSharedMessages(messages: readonly SharedTextMessage[], options: SharedSearchOptions = {}): SharedSearchPage {
  const { query = "", kind = "all", author = "", before = Number.MAX_SAFE_INTEGER, limit = 30 } = options;
  if (typeof query !== "string" || query.length > 200 || !sharedSearchKinds.includes(kind) ||
      (author !== "" && !parseContactId(author)) || !Number.isSafeInteger(before) || before < 1 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("invalid conversation search");
  const needle = query.normalize("NFKC").trim().toLowerCase();
  const found: SharedTextMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.sequence >= before || message.deletedAt || message.kind === "activity" || (author && contactId(message.actor) !== author)) continue;
    if (kind === "people" && message.actor.kind !== "person" || kind === "bots" && message.actor.kind !== "bot" ||
        kind === "files" && !message.attachments?.length || kind === "links" && !/https?:\/\/[^\s<>]+/i.test(message.text) ||
        kind === "results" && (message.actor.kind !== "bot" || !message.responseTo)) continue;
    const text = [message.text, ...(message.attachments ?? []).map(file => file.name)].join("\n").normalize("NFKC").toLowerCase();
    if (needle && !text.includes(needle)) continue;
    found.push(message);
    if (found.length > limit) break;
  }
  const page = found.slice(0, limit);
  return { messages: page, hasMore: found.length > limit, before: page.at(-1)?.sequence ?? null };
}
