import type { Bot } from "@/state/store";
import { fromMarkdown } from "mdast-util-from-markdown";

export interface SharedRoom {
  id: string; homeId: string; name: string; memberIds: string[];
  kind?: "direct" | "group"; revision?: number; createdBy?: string;
  unreadCount?: number; readSequence?: number; notifications?: SharedNotifications;
}
export type SharedNotifications = "all" | "mentions" | "muted";
export interface SharedPreferences { readSequence: number; notifications: SharedNotifications }
export interface SharedAttachment { id: string; name: string; mime: string; size: number }
export interface SharedFile {
  attachment: SharedAttachment; messageId: string; sequence: number;
  actor: { homeId: string; kind: string; localId: string }; at: number;
}
export interface SharedFilesPage { files: SharedFile[]; hasMore: boolean; before: number | null }
export interface SharedMessage {
  id: string; sequence: number; sendId: string;
  actor: { homeId: string; kind: string; localId: string };
  text: string; at: number; attachments?: SharedAttachment[];
  kind?: "text" | "activity"; tool?: { name: string; ok?: boolean; spoken?: string };
  responseTo?: string;
  replyTo?: string; editedAt?: number; deletedAt?: number; changeSequence?: number;
}

/** Keep a settled activity in the position of its latest update. Scope the
 * receipt to its bot and request: two owners may use the same tool id. */
export function sharedVisibleMessages(messages: readonly SharedMessage[]): SharedMessage[] {
  const key = (message: SharedMessage) => message.actor.kind === "bot" && message.kind === "activity" && message.sendId.startsWith("activity-")
    ? `${message.actor.homeId}:${message.actor.localId}:${message.responseTo ?? ""}:${message.sendId.replace(/-(?:start|ok|failed)$/, "")}` : null;
  const latest = new Map<string, number>();
  messages.forEach((message, index) => { const id = key(message); if (id) latest.set(id, index); });
  return messages.filter((message, index) => { const id = key(message); return !id || latest.get(id) === index; });
}

export function sharedReplyReference(message: SharedMessage): string | undefined {
  return message.deletedAt ? undefined : message.replyTo ?? (message.actor.kind === "bot" ? message.responseTo : undefined);
}

export function sharedActivityLabel(message: Pick<SharedMessage, "tool" | "text">): string {
  const tool = message.tool;
  if (tool && ["working", "still working"].includes(tool.name) && tool.ok !== undefined) {
    return tool.ok ? "Completed" : tool.spoken && !/is (?:still )?working on this$/.test(tool.spoken) ? tool.spoken : "Stopped";
  }
  return tool?.spoken?.trim() || message.text.trim() || tool?.name.trim() || "";
}

export function sharedHasActiveWork(messages: readonly SharedMessage[]): boolean {
  const answered = new Set(messages.filter(message => message.actor.kind === "bot" && message.responseTo && message.kind !== "activity")
    .map(message => `${message.actor.homeId}:${message.actor.localId}:${message.responseTo}`));
  return sharedVisibleMessages(messages).some(message => message.kind === "activity" && message.tool?.ok === undefined && Boolean(message.tool)
    && !answered.has(`${message.actor.homeId}:${message.actor.localId}:${message.responseTo ?? ""}`));
}
export interface SharedHistoryPage { messages: SharedMessage[]; changes?: SharedMessage[]; version?: number; hasMore?: boolean }
export interface SharedHistory {
  messages: SharedMessage[]; sequence: number; version: number; hasMore: boolean; changeRevision: number;
}
export const emptySharedHistory = (): SharedHistory => ({ messages: [], sequence: 0, version: 0, hasMore: false, changeRevision: 0 });

/** Content changes never import unloaded history or advance the append cursor.
 * An old scrollback/mutation response cannot skip changes awaiting the poll. */
export function mergeSharedHistory(current: SharedHistory, page: SharedHistoryPage, source: "latest" | "after" | "before" | "mutation"): SharedHistory {
  const byId = new Map(current.messages.map(message => [message.id, message]));
  let changed = false;
  const merge = (message: SharedMessage, onlyLoaded: boolean) => {
    const previous = byId.get(message.id);
    if (!previous && onlyLoaded) return;
    if (previous && (previous.changeSequence ?? 0) > (message.changeSequence ?? 0)) return;
    if (previous && JSON.stringify(previous) === JSON.stringify(message)) return;
    if (previous) changed = true;
    byId.set(message.id, message);
  };
  for (const message of page.messages) merge(message, source === "mutation");
  for (const message of page.changes ?? []) merge(message, true);
  return {
    messages: [...byId.values()].sort((a, b) => a.sequence - b.sequence),
    sequence: source === "mutation" ? current.sequence : Math.max(current.sequence, ...page.messages.map(message => message.sequence)),
    version: source === "latest" || source === "after" ? Math.max(current.version, page.version ?? 0)
      // A scrollback snapshot can predate an edit that a concurrent poll
      // skipped while the row was unloaded. Replay those changes next poll.
      : source === "before" ? Math.min(current.version, page.version ?? current.version) : current.version,
    hasMore: source === "latest" || source === "before" ? (page.hasMore ?? (page.messages[0]?.sequence ?? 0) > 1) : current.hasMore,
    changeRevision: current.changeRevision + (changed ? 1 : 0),
  };
}

export function sharedReadSequenceToSave(latest: number, read: number, visible: boolean, focused: boolean): number | null {
  return visible && focused && latest > read ? latest : null;
}

export function sharedRoomUnread(room: { unreadCount?: number; lastActivity?: number }, legacySeen: number): boolean {
  return typeof room.unreadCount === "number" ? room.unreadCount > 0 : (room.lastActivity ?? 0) > legacySeen;
}

export function sharedAttachmentError(file: { name: string; type: string; size: number }): string | null {
  const limit = file.type.startsWith("image/") ? 10 : 25;
  return file.size > limit * 1024 * 1024 ? `${file.name} exceeds the ${limit} MB ${limit === 10 ? "image" : "file"} limit.` : null;
}
export interface SharedContact {
  id: string; name: string; kind: "person" | "bot"; title?: string;
  avatar?: string | null; color?: string; mascotBody?: string | null;
}
export interface SharedEligibleBot {
  id: string; name: string; ownerName: string; color?: Bot["color"];
  availability?: "ready" | "offline" | "update-required" | "reconnect-required";
  mascotBody?: Bot["mascotBody"]; avatarUrl?: string | null;
}
export interface SharedComposer {
  send: (text: string, files: File[], sendId: string, options?: { replyTo?: string }) => Promise<void>;
  mentionBots: Bot[];
}

export function isDirectSharedRoom(room: Pick<SharedRoom, "kind" | "memberIds">): boolean {
  return room.kind ? room.kind === "direct" : room.memberIds.length === 2;
}

/** Only the room's authorized roster becomes composer choices. A name shared
 * by two owners must have an explicit owner in its inserted mention. */
export function sharedMentionBots(bots: readonly SharedEligibleBot[]): Bot[] {
  const count = (name: string) => bots.filter(bot => bot.name.toLocaleLowerCase() === name.toLocaleLowerCase()).length;
  const labels = bots.map(bot => count(bot.name) > 1 ? `${bot.name} · ${bot.ownerName}` : bot.name);
  return bots.map((bot, index) => ({
    id: bot.id, threadId: `shared-bot:${bot.id}`,
    name: labels[index],
    title: `${bot.ownerName}'s bot${bot.availability && bot.availability !== "ready" ? ` · ${bot.availability.replaceAll("-", " ")}` : ""}`, description: "", notifications: false,
    color: bot.color ?? "blue", mascotBody: bot.mascotBody, avatarUrl: bot.avatarUrl,
    unread: false, busy: false, modelSelection: { instanceId: "shared", model: "shared" },
    messages: [], activeLeafId: null,
  }));
}

export function sharedBotTargets(text: string, bots: readonly Bot[]): string[] {
  // Match the server's inert markdown contexts so mentioning a bot in code
  // or a quote cannot turn an ordinary send into an invalid explicit target.
  const parts: string[] = [];
  type Node = { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
  const walk = (node: Node) => {
    if (["code", "inlineCode", "blockquote", "link", "image", "html"].includes(node.type)) return;
    if (node.type === "text") parts.push(node.position?.start.offset !== undefined && node.position.end.offset !== undefined
      ? text.slice(node.position.start.offset, node.position.end.offset) : node.value ?? "");
    else node.children?.forEach(walk);
  };
  walk(fromMarkdown(text) as Node);
  const lower = parts.join("\n").replace(/"[^"\n]*"|“[^”\n]*”/g, "").toLocaleLowerCase();
  return [...new Set(bots.filter(bot => {
    const alias = `@${bot.name}`.toLocaleLowerCase();
    let index = lower.indexOf(alias);
    while (index >= 0) {
      const before = lower[index - 1] ?? " ";
      const after = lower[index + alias.length] ?? " ";
      if (!/[\p{L}\p{N}_@\\]/u.test(before) && !/[\p{L}\p{N}_-]/u.test(after)) return true;
      index = lower.indexOf(alias, index + 1);
    }
    return false;
  }).map(bot => bot.id))];
}
