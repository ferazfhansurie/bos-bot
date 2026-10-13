// Durable local store for natively captured WhatsApp messages.
//
// Same pattern as message-db.ts: node:sqlite (no dependency to bundle), WAL,
// owner-only file permissions. One row per whatsapp-web.js serialized message
// id; `message_create` can fire more than once for the same message (it fires
// for received and sent-by-me messages, and again on some reconnects), so the
// insert is INSERT OR IGNORE and a duplicate is a no-op.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CapturedMessage } from "./whatsapp-types.ts";

export interface WhatsAppChatSummary {
  chatId: string;
  chatName: string | null;
  messageCount: number;
  lastTimestamp: number;
  lastBody: string;
  lastFromMe: boolean;
}

export interface WhatsAppStoredMessage extends CapturedMessage {
  capturedAt: number;
}

export interface ListMessagesQuery {
  accountId?: string;
  chatIds?: string[];
  chatId?: string;
  /** only messages strictly older than this unix-seconds timestamp */
  before?: number;
  /** case-insensitive substring match on the body */
  query?: string;
  limit?: number;
}

const MAX_LIMIT = 200;
const clampLimit = (value: number | undefined, fallback: number) =>
  Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(value) ? Math.floor(value!) : fallback));

interface Row {
  account_id: string | null;
  id: string;
  chat_id: string;
  chat_name: string | null;
  from_id: string;
  author: string | null;
  from_me: number;
  timestamp: number;
  type: string;
  body: string;
  has_media: number;
  captured_at: number;
}

const fromRow = (row: Row): WhatsAppStoredMessage => ({
  accountId: row.account_id ?? null,
  id: row.id,
  chatId: row.chat_id,
  chatName: row.chat_name,
  from: row.from_id,
  author: row.author,
  fromMe: row.from_me === 1,
  timestamp: row.timestamp,
  type: row.type,
  body: row.body,
  hasMedia: row.has_media === 1,
  capturedAt: row.captured_at,
});

export class WhatsAppStore {
  private db: DatabaseSync | null = null;
  private readonly file: string;
  private readonly now: () => number;

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
  }

  private open(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Private conversations: create owner-only and repair a permissive umask.
    closeSync(openSync(this.file, "a", 0o600));
    try {
      chmodSync(this.file, 0o600);
    } catch {}
    const db = new DatabaseSync(this.file);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        chat_name TEXT,
        from_id TEXT NOT NULL,
        author TEXT,
        from_me INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        has_media INTEGER NOT NULL,
        captured_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_time ON whatsapp_messages(chat_id, timestamp);
      CREATE INDEX IF NOT EXISTS whatsapp_messages_time ON whatsapp_messages(timestamp);
    `);
    this.db = db;
    const columns = db.prepare("PRAGMA table_info(whatsapp_messages)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "account_id")) db.exec("ALTER TABLE whatsapp_messages ADD COLUMN account_id TEXT");
    return db;
  }

  /** true when the row is new, false when this id was already stored */
  insert(message: CapturedMessage): boolean {
    const result = this.open().prepare(`
      INSERT OR IGNORE INTO whatsapp_messages
        (id, chat_id, chat_name, from_id, author, from_me, timestamp, type, body, has_media, captured_at, account_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.id,
      message.chatId,
      message.chatName,
      message.from,
      message.author,
      message.fromMe ? 1 : 0,
      Math.floor(message.timestamp),
      message.type,
      message.body,
      message.hasMedia ? 1 : 0,
      this.now(),
      message.accountId ?? null,
    );
    return Number(result.changes) > 0;
  }

  count(): number {
    const row = this.open().prepare("SELECT COUNT(*) AS n FROM whatsapp_messages").get() as { n: number };
    return Number(row.n);
  }

  message(id: string): WhatsAppStoredMessage | undefined {
    const row = this.open().prepare("SELECT * FROM whatsapp_messages WHERE id = ?").get(id) as unknown as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  listChats(limit?: number, chatIds?: string[], accountId?: string): WhatsAppChatSummary[] {
    if (chatIds?.length === 0) return [];
    const rows = this.open().prepare(`
      SELECT m.chat_id, m.chat_name, m.body, m.from_me, m.timestamp, c.n
      FROM (
        SELECT chat_id, MAX(timestamp) AS last, COUNT(*) AS n FROM whatsapp_messages ${chatIds || accountId ? `WHERE ${[...(chatIds ? [`chat_id IN (${chatIds.map(() => "?").join(",")})`] : []), ...(accountId ? ["account_id = ?"] : [])].join(" AND ")}` : ""} GROUP BY chat_id
      ) c
      JOIN whatsapp_messages m ON m.chat_id = c.chat_id AND m.timestamp = c.last
      ${accountId ? "WHERE m.account_id = ?" : ""}
      GROUP BY m.chat_id
      ORDER BY m.timestamp DESC
      LIMIT ?
    `).all(...(chatIds ?? []), ...(accountId ? [accountId, accountId] : []), clampLimit(limit, 30)) as Array<{ chat_id: string; chat_name: string | null; body: string; from_me: number; timestamp: number; n: number }>;
    return rows.map((row) => ({
      chatId: row.chat_id,
      chatName: row.chat_name ?? (accountId ? null : this.latestChatName(row.chat_id)),
      messageCount: Number(row.n),
      lastTimestamp: row.timestamp,
      lastBody: row.body,
      lastFromMe: row.from_me === 1,
    }));
  }

  private latestChatName(chatId: string): string | null {
    const row = this.open().prepare(
      "SELECT chat_name FROM whatsapp_messages WHERE chat_id = ? AND chat_name IS NOT NULL ORDER BY timestamp DESC LIMIT 1",
    ).get(chatId) as { chat_name: string } | undefined;
    return row?.chat_name ?? null;
  }

  /** newest first */
  listMessages(query: ListMessagesQuery = {}): WhatsAppStoredMessage[] {
    if (query.chatIds?.length === 0) return [];
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (query.accountId) { where.push("account_id = ?"); params.push(query.accountId); }
    if (query.chatIds) {
      where.push(`chat_id IN (${query.chatIds.map(() => "?").join(",")})`);
      params.push(...query.chatIds);
    }
    if (query.chatId) {
      where.push("chat_id = ?");
      params.push(query.chatId);
    }
    if (query.before !== undefined && Number.isFinite(query.before)) {
      where.push("timestamp < ?");
      params.push(Math.floor(query.before));
    }
    if (query.query) {
      where.push("body LIKE ? ESCAPE '\\'");
      params.push(`%${query.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const sql = `SELECT * FROM whatsapp_messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY timestamp DESC, captured_at DESC LIMIT ?`;
    params.push(clampLimit(query.limit, 50));
    return (this.open().prepare(sql).all(...params) as unknown as Row[]).map(fromRow);
  }

  close(): void {
    try {
      this.db?.close();
    } catch {}
    this.db = null;
  }
}
