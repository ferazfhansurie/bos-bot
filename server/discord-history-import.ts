import { createHash } from "node:crypto";
import type { Message, Store } from "./store.ts";
import { readCommandReceipt } from "./message-db.ts";

const TARGETS = new Map([
  ["1528290901837746296", { botId: "00000000-0000-4000-8000-000000000002", name: "chatgpt" }],
  ["1552216434053222400", { botId: "a5cd9d23-e9e4-4745-8348-e786bf6787c2", name: "claude" }],
]);
const GUILD = "1025253183716605962";
const sourceId = /^(?:\d{17,20}|\d{17,20}:resume:\d{13})$/;

export interface SourceMessage {
  message_id: string; body: string; received_at: number;
  role: "user" | "assistant"; author_name: string; delivery_state: string;
  reply_to_id?: string; attachments?: unknown[];
}
export interface SourceChannel {
  channel: { guild_id: string; channel_id: string; name: string; conversation_key: string; created_at: number };
  messages: SourceMessage[];
}
export interface SourceExport { version: number; source: string; exportedAt: number; channels: SourceChannel[] }
export interface ImportPlan { botId: string; channelId: string; name: string; threadId: string; messages: Message[]; digest: string; unsupportedAttachments: number; unresolvedReplies: number }

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

/** Validates the complete export before any target task or transcript is written. */
export function planDiscordHistory(input: unknown): ImportPlan[] {
  const root = requireRecord(input, "export");
  if (root.version !== 1 || !Array.isArray(root.channels) || root.channels.length !== 2) throw new Error("Expected the audited two-channel v1 export");
  const seenChannels = new Set<string>();
  const plans: ImportPlan[] = [];
  for (const raw of root.channels) {
    const entry = requireRecord(raw, "channel entry");
    const channel = requireRecord(entry.channel, "channel");
    const channelId = String(channel.channel_id ?? "");
    const target = TARGETS.get(channelId);
    if (!target || channel.guild_id !== GUILD || channel.name !== target.name ||
        channel.conversation_key !== `guild:${GUILD}:channel:${channelId}` || seenChannels.has(channelId)) {
      throw new Error(`Unexpected or duplicate source channel ${channelId}`);
    }
    seenChannels.add(channelId);
    if (!Array.isArray(entry.messages)) throw new Error(`Missing messages for ${channelId}`);
    const rows: SourceMessage[] = [];
    const sourceIds = new Set<string>();
    for (const item of entry.messages) {
      const m = requireRecord(item, "message");
      if (typeof m.message_id !== "string" || !sourceId.test(m.message_id) ||
          typeof m.body !== "string" || typeof m.received_at !== "number" || !Number.isSafeInteger(m.received_at) || m.received_at <= 0 ||
          !["user", "assistant"].includes(String(m.role)) || typeof m.author_name !== "string" ||
          typeof m.delivery_state !== "string") throw new Error(`Malformed source message in ${channelId}`);
      if (sourceIds.has(m.message_id)) throw new Error(`Duplicate source message ${m.message_id}`);
      sourceIds.add(m.message_id);
      rows.push(m as unknown as SourceMessage);
    }
    rows.sort((a, b) => a.received_at - b.received_at || a.message_id.localeCompare(b.message_id));
    const threadId = `discord-import-${digest(`${GUILD}:${channelId}`).slice(0, 24)}`;
    let previous: string | null = null;
    let unsupportedAttachments = 0;
    let unresolvedReplies = 0;
    const messages: Message[] = rows.map((row) => {
      const id = `discord-${row.message_id}`;
      const replyToId = row.reply_to_id && sourceIds.has(row.reply_to_id) ? `discord-${row.reply_to_id}` : undefined;
      if (row.reply_to_id && !replyToId) unresolvedReplies++;
      if (row.attachments?.length) unsupportedAttachments += row.attachments.length;
      const message: Message = {
        id, at: row.received_at, role: row.role === "assistant" ? "bot" : "user", kind: "text",
        text: row.body, parentId: previous,
        ...(replyToId ? { replyToId } : {}),
        ...(row.role === "user" ? { sender: { name: row.author_name } } : {}),
        discordImport: { guildId: GUILD, channelId, messageId: row.message_id,
          authorName: row.author_name, deliveryState: row.delivery_state },
      };
      previous = id;
      return message;
    });
    plans.push({ botId: target.botId, channelId, name: target.name, threadId,
      messages, digest: digest(messages), unsupportedAttachments, unresolvedReplies });
  }
  if (seenChannels.size !== TARGETS.size) throw new Error("Missing audited source channel");
  return plans;
}

/** Offline only. Existing imported rows must match exactly; an interrupted run
 * that created an empty task can safely resume. No agent dispatch occurs. */
export function applyDiscordHistory(store: Store, plans: ImportPlan[]): Array<{ channelId: string; threadId: string; count: number; replayed: boolean }> {
  for (const plan of plans) if (!store.bot(plan.botId)) throw new Error(`Missing existing target bot ${plan.botId}`);
  return plans.map((plan) => {
    const existingTask = store.bot(plan.botId)?.tasks?.find((task) => task.threadId === plan.threadId);
    if (existingTask && existingTask.title !== `Imported Discord #${plan.name}`) throw new Error(`Imported task collision ${plan.threadId}`);
    const existing = store.messagesFor(plan.threadId);
    const receipt = readCommandReceipt("discord-history-import", plan.threadId);
    if (existing.length) {
      if (!existingTask || digest(existing) !== plan.digest || receipt?.result !== plan.digest)
        throw new Error(`Imported transcript mismatch ${plan.threadId}`);
      return { channelId: plan.channelId, threadId: plan.threadId, count: existing.length, replayed: true };
    }
    if (receipt) throw new Error(`Import receipt without transcript ${plan.threadId}`);
    store.createImportedTask(plan.botId, plan.threadId, `Imported Discord #${plan.name}`, plan.messages[0]?.at ?? Date.now());
    store.importTranscript(plan.threadId, plan.messages, plan.messages.at(-1)?.id ?? null,
      { kind: "discord-history-import", key: plan.threadId, result: plan.digest });
    return { channelId: plan.channelId, threadId: plan.threadId, count: plan.messages.length, replayed: false };
  });
}
