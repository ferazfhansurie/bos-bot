// Owner-configured client-only replies. No groups or retries. Proactive sends only
// with an explicit outreach grant, and only to the policy's named chat list.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { WhatsAppStore, WhatsAppStoredMessage } from "./whatsapp-store.ts";

export interface ReplyPolicy { accountId: string; chatIds: string[] | null; autoDispatch: boolean; enabledAt: number; outreach?: boolean }
export interface SendInput { account_id: string; chat_id: string; text: string; send_key: string }
export interface ReplyInput { account_id: string; chat_id: string; message_id: string; text: string }
export interface ReplyReceipt { state: "sending" | "submitted" | "outcome_unknown"; messageId?: string; fingerprint: string }
export interface ReplyTransport {
  accountId(): string | null;
  reply(input: ReplyInput, authorized: () => boolean): Promise<string>;
}
const individual = /^\d{6,20}@c\.us$/;
// WhatsApp now addresses many one-to-one chats by a privacy id (<digits>@lid) instead of the phone number
const person = /^(\d{6,20}@c\.us|\d{6,25}@lid)$/;
const chat = /^(\d{6,20}@c\.us|\d{6,25}@lid|[\d-]{6,40}@g\.us)$/;

export class WhatsAppReplies {
  private root: string;
  private store: WhatsAppStore;
  private transport: () => ReplyTransport | null;
  private now: () => number;
  constructor(root: string, store: WhatsAppStore, transport: () => ReplyTransport | null, now = Date.now) {
    this.root = root; this.store = store; this.transport = transport; this.now = now;
  }
  private read<T>(name: string, fallback: T): T {
    const file = join(this.root, name);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : fallback;
  }
  private write(name: string, value: unknown): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const file = join(this.root, name);
    writeFileSync(file + ".tmp", JSON.stringify(value), { mode: 0o600 });
    const fd = openSync(file + ".tmp", "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(file + ".tmp", file);
    const dir = openSync(this.root, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  policies(): Record<string, ReplyPolicy> { return this.read("reply-policies.json", {}); }
  policy(botId: string): ReplyPolicy | undefined { return this.policies()[botId]; }
  configure(botId: string, value: unknown): void {
    const policies = this.policies();
    // Keep a restricted tombstone: revoking replies must not restore global
    // access to the owner's personal and Ops capture history.
    if (value === null) { if (policies[botId]) policies[botId] = { ...policies[botId], chatIds: [], enabledAt: this.now() }; }
    else {
      const p = value as ReplyPolicy;
      if (!p || !individual.test(p.accountId) || (p.chatIds !== null && (!Array.isArray(p.chatIds) || p.chatIds.length > 200 || p.chatIds.some(id => typeof id !== "string" || !chat.test(id) || id === p.accountId))) || (p.autoDispatch !== undefined && typeof p.autoDispatch !== "boolean") || (p.chatIds === null && p.autoDispatch === true) || (p.outreach !== undefined && typeof p.outreach !== "boolean") || (p.chatIds === null && p.outreach === true)) throw new Error("accountId required; chatIds is an explicit list or null for owner-granted shared access. automatic dispatch and outreach require a named chat list");
      policies[botId] = { accountId: p.accountId, chatIds: p.chatIds === null ? null : [...new Set(p.chatIds)], autoDispatch: p.autoDispatch === true, enabledAt: this.now(), ...(p.outreach === true ? { outreach: true } : {}) };
    }
    this.write("reply-policies.json", policies);
  }
  account(botId: string): string | null {
    const policy = this.policy(botId);
    const account = this.transport()?.accountId() ?? null;
    return policy && account === policy.accountId ? account : null;
  }
  eligible(botId: string, message: WhatsAppStoredMessage): boolean {
    const p = this.policy(botId);
    return !!p && message.accountId === p.accountId && this.account(botId) === p.accountId && (p.chatIds === null || p.chatIds.includes(message.chatId)) && !message.fromMe && message.type === "chat" && (!p.autoDispatch || message.timestamp * 1000 >= p.enabledAt - 1000) && message.timestamp <= this.now() / 1000 + 60 && message.timestamp >= this.now() / 1000 - 86400;
  }
  claimInbound(botId: string, message: WhatsAppStoredMessage): boolean {
    if (!this.policy(botId)?.autoDispatch || !this.eligible(botId, message)) return false;
    const key = createHash("sha256").update(JSON.stringify([botId, this.account(botId), message.id])).digest("hex");
    const claims = this.read<Record<string, number>>("reply-dispatches.json", {});
    if (claims[key]) return false;
    claims[key] = this.now();
    this.write("reply-dispatches.json", claims);
    return true;
  }
  async reply(botId: string, input: ReplyInput, authorized: () => boolean = () => true): Promise<ReplyReceipt> {
    if (!input || typeof input.account_id !== "string" || typeof input.chat_id !== "string" || typeof input.message_id !== "string" || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000) throw new Error("account_id, chat_id, message_id and text (1–4000 characters) required");
    const p = this.policy(botId);
    const transport = this.transport();
    if (!p || !transport || transport.accountId() !== p.accountId || input.account_id !== p.accountId || !chat.test(input.chat_id) || input.chat_id === p.accountId || (p.chatIds !== null && !p.chatIds.includes(input.chat_id))) throw new Error("reply account or client recipient is not authorized");
    const source = this.store.message(input.message_id);
    if (!source || source.chatId !== input.chat_id || !this.eligible(botId, source)) throw new Error("reply must reference a captured incoming client text from the last 24 hours");
    // Cross-bot dedupe: at most one outbound reply per inbound message/account.
    const key = createHash("sha256").update(JSON.stringify([p.accountId, input.message_id])).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const ledger = this.read<Record<string, ReplyReceipt>>("reply-receipts.json", {});
    if (ledger[key]) {
      if (ledger[key].fingerprint !== fingerprint) throw new Error("this incoming message already has a reply attempt; no retry allowed");
      return { ...ledger[key], state: ledger[key].state === "sending" ? "outcome_unknown" : ledger[key].state };
    }
    // Persist before crossing the network. A crash, timeout or exception can
    // never turn the next invocation into a second send.
    ledger[key] = { state: "sending", fingerprint };
    this.write("reply-receipts.json", ledger);
    let receipt: ReplyReceipt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const messageId = await Promise.race([transport.reply(input, () => authorized() && this.policy(botId)?.accountId === input.account_id && this.eligible(botId, source)), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("reply timed out")), 30_000); })]);
      receipt = messageId ? { state: "submitted", messageId, fingerprint } : { state: "outcome_unknown", fingerprint };
    } catch { receipt = { state: "outcome_unknown", fingerprint }; }
    finally { clearTimeout(timer); }
    const latest = this.read<Record<string, ReplyReceipt>>("reply-receipts.json", {});
    latest[key] = receipt;
    this.write("reply-receipts.json", latest);
    return receipt;
  }
  /** Outreach grant: start or continue a conversation in a named individual chat
   * without an incoming message or time window. One attempt per send_key. */
  async send(botId: string, input: SendInput, authorized: () => boolean = () => true): Promise<ReplyReceipt> {
    if (!input || typeof input.account_id !== "string" || typeof input.chat_id !== "string" || typeof input.send_key !== "string" || !/^[\w.:-]{1,120}$/.test(input.send_key) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 4000)
      throw new Error("account_id, chat_id, send_key (1–120 word characters) and text (1–4000 characters) required");
    const granted = () => {
      const p = this.policy(botId);
      return !!p && p.outreach === true && Array.isArray(p.chatIds) && p.chatIds.includes(input.chat_id) && p.accountId === input.account_id;
    };
    const transport = this.transport();
    if (!granted() || !transport || transport.accountId() !== input.account_id || !person.test(input.chat_id) || input.chat_id === input.account_id)
      throw new Error("outreach is not granted for this account and chat");
    const key = createHash("sha256").update(JSON.stringify([input.account_id, "send", botId, input.send_key])).digest("hex");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const ledger = this.read<Record<string, ReplyReceipt>>("reply-receipts.json", {});
    if (ledger[key]) {
      if (ledger[key].fingerprint !== fingerprint) throw new Error("this send_key already has a send attempt; no retry allowed");
      return { ...ledger[key], state: ledger[key].state === "sending" ? "outcome_unknown" : ledger[key].state };
    }
    ledger[key] = { state: "sending", fingerprint };
    this.write("reply-receipts.json", ledger);
    let receipt: ReplyReceipt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const messageId = await Promise.race([transport.reply({ account_id: input.account_id, chat_id: input.chat_id, message_id: "", text: input.text }, () => authorized() && granted()), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("send timed out")), 30_000); })]);
      receipt = messageId ? { state: "submitted", messageId, fingerprint } : { state: "outcome_unknown", fingerprint };
    } catch {
      receipt = { state: "outcome_unknown", fingerprint };
    } finally {
      clearTimeout(timer);
    }
    const latest = this.read<Record<string, ReplyReceipt>>("reply-receipts.json", {});
    latest[key] = receipt;
    this.write("reply-receipts.json", latest);
    return receipt;
  }
}
