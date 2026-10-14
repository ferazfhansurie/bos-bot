import { randomBytes, createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic.ts';

type User = { id: number; is_bot?: boolean; username?: string; first_name?: string };
type Message = { message_id: number; date?: number; from?: User; sender_chat?: unknown; chat: { id: number; type: string; title?: string }; text?: string; caption?: string; message_thread_id?: number; reply_to_message?: { from?: User } };
export type TelegramUpdate = { update_id: number; message?: Message; managed_bot?: { user: User; bot: User } };
type Pending = { hash: string; expires: number; username: string; name: string; owner?: number };
type Connection = { id: number; username: string; owner: number; members: number[]; groups: number[]; offset: number; connectedAt: number; error?: string };
type Job = { id: string; botId: string; chatId: number; topic?: number; actor: number; messageId: number; text: string; phase: 'queued' | 'running' | 'done' | 'interrupted' };
type State = { threads?: Record<string, string>; managerOffset: number; managerId?: number; pending: Record<string, Pending>; connections: Record<string, Connection>; invites: Record<string, { hash: string; expires: number }>; jobs: Job[] };
export type TelegramCall = <T>(token: string, method: string, body: Record<string, unknown>) => Promise<T>;
export type ChannelReply = { text: string; waiting?: boolean };
type Hooks = { exists: (botId: string) => boolean; cancel?: (botId: string) => void; run: (job: Job, active: () => boolean, progress: (text: string) => Promise<void>) => Promise<ChannelReply> };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
export const telegramCall: TelegramCall = async <T>(token: string, method: string, body: Record<string, unknown>): Promise<T> => {
  // Never propagate fetch errors: their URL contains the credential.
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const data = await response.json() as { ok: boolean; result: T };
    if (!response.ok || !data.ok) throw new Error();
    return data.result;
  } catch { throw new Error('telegram could not complete the request; check the connection and try again'); }
};

/** Managed credentials stay in memory. Only IDs, pairing hashes and delivery state go to disk. */
export class TelegramChannels {
  private state: State;
  private manager?: User;
  private tokens = new Map<number, string>();
  private stopped = true;
  private polling = new Set<string>();
  private running = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private error?: string;
  private revisions = new Map<string, number>();
  private options: { dataDir: string; managerToken?: string; hooks: Hooks; call?: TelegramCall; now?: () => number };
  constructor(options: { dataDir: string; managerToken?: string; hooks: Hooks; call?: TelegramCall; now?: () => number }) {
    this.options = options;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.state = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : { managerOffset: 0, pending: {}, connections: {}, invites: {}, jobs: [] };
    for (const job of this.state.jobs) if (job.phase === 'running') job.phase = 'interrupted';
    this.save();
  }
  private get file() { return join(this.options.dataDir, 'telegram-channels.json'); }
  private now() { return this.options.now?.() ?? Date.now(); }
  private save() { writeFileAtomic(this.file, JSON.stringify(this.state), { mode: 0o600 }); }
  private call<T>(token: string, method: string, body: Record<string, unknown> = {}) { return (this.options.call ?? telegramCall)<T>(token, method, body); }
  status(botId: string) {
    const connection = this.state.connections[botId];
    const pending = this.state.pending[botId];
    return { configured: Boolean(this.options.managerToken), ready: Boolean(this.manager), error: connection?.error ?? this.error,
      connection: connection ? { username: connection.username, connectedAt: connection.connectedAt, members: connection.members.length, groups: connection.groups.length } : null,
      pending: Boolean(pending && pending.expires > this.now()),
      interrupted: this.state.jobs.filter(j => j.botId === botId && j.phase === 'interrupted').length };
  }
  async connect(botId: string, name: string, authorized: () => boolean = () => true) {
    if (!this.options.managerToken) fail('telegram setup is needed on this server', 409);
    if (!this.options.hooks.exists(botId)) fail('no such bot', 404);
    if (this.state.connections[botId]) fail('disconnect the existing channel first', 409);
    const revision = (this.revisions.get(botId) ?? 0) + 1;
    this.revisions.set(botId, revision);
    if (!this.manager) await this.identify();
    if (!authorized() || this.revisions.get(botId) !== revision || !this.options.hooks.exists(botId)) fail("connection cancelled", 409);
    const code = randomBytes(24).toString('base64url');
    const username = `bos_${randomBytes(8).toString('hex')}_bot`;
    this.state.pending[botId] = { hash: hash(code), expires: this.now() + 15 * 60_000, username, name: name.slice(0, 64) };
    this.save();
    return { url: `https://t.me/${this.manager!.username}?start=${code}`, expiresAt: this.state.pending[botId].expires };
  }
  conversation(botId: string, chatId: number, topic = 0) {
    const c = this.state.connections[botId];
    return c ? this.state.threads?.[`${botId}:${c.id}:${chatId}:${topic}`] : undefined;
  }
  rememberConversation(botId: string, chatId: number, topic: number, threadId: string) {
    const c = this.state.connections[botId];
    if (!c) fail('telegram access ended', 409);
    this.state.threads ??= {};
    this.state.threads[`${botId}:${c.id}:${chatId}:${topic}`] = threadId;
    this.save();
  }
  invite(botId: string) {
    const c = this.state.connections[botId];
    if (!c) fail('connect telegram first', 409);
    const code = randomBytes(24).toString('base64url');
    this.state.invites[botId] = { hash: hash(code), expires: this.now() + 15 * 60_000 }; this.save();
    return { url: `https://t.me/${c.username}?start=${code}` };
  }
  disconnect(botId: string) {
    this.revisions.set(botId, (this.revisions.get(botId) ?? 0) + 1);
    const c = this.state.connections[botId];
    if (c) this.tokens.delete(c.id);
    delete this.state.connections[botId]; delete this.state.pending[botId]; delete this.state.invites[botId];
    for (const j of this.state.jobs) if (j.botId === botId && j.phase === 'queued') j.phase = 'interrupted';
    this.save(); this.options.hooks.cancel?.(botId);
  }
  private async identify() {
    const manager = await this.call<User>(this.options.managerToken!, 'getMe');
    if (!manager.is_bot || !manager.username) fail('telegram manager identity is unavailable', 409);
    if (this.state.managerId && this.state.managerId !== manager.id) fail('this server was paired with another telegram manager', 409);
    const webhook = await this.call<{ url: string }>(this.options.managerToken!, 'getWebhookInfo');
    if (webhook.url) fail('this manager already has a webhook; use a dedicated manager', 409);
    this.state.managerId = manager.id; this.manager = manager; this.save();
  }
  async start() {
    if (!this.options.managerToken || !this.stopped) return;
    this.stopped = false;
    const tick = () => {
      if (this.stopped) return;
      void this.poll('manager', async () => { if (!this.manager) await this.identify(); await this.pollManager(); });
      for (const botId of Object.keys(this.state.connections)) {
        void this.poll(botId, () => this.pollConnection(botId));
        this.drain(botId);
      }
      this.timer = setTimeout(tick, 1500); this.timer.unref();
    };
    tick();
  }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  private async poll(key: string, run: () => Promise<void>) {
    if (this.polling.has(key)) return;
    this.polling.add(key);
    try { await run(); if (key === 'manager') this.error = undefined; else if (this.state.connections[key]) this.state.connections[key].error = undefined; }
    catch { if (key === 'manager') this.error = 'telegram manager is unavailable'; else if (this.state.connections[key]) this.state.connections[key].error = 'telegram connection needs attention'; }
    finally { this.polling.delete(key); }
  }
  private async pollManager() {
    const updates = await this.call<TelegramUpdate[]>(this.options.managerToken!, 'getUpdates', { offset: this.state.managerOffset, timeout: 20, limit: 50, allowed_updates: ['message', 'managed_bot'] });
    if (this.stopped) return;
    for (const u of updates) { await this.handleManager(u); this.state.managerOffset = u.update_id + 1; this.save(); }
  }
  async handleManager(u: TelegramUpdate) {
    const m = u.message;
    if (m?.chat.type === 'private' && m.from && !m.from.is_bot && m.chat.id === m.from.id) {
      const code = m.text?.match(/^\/start ([\w-]+)$/)?.[1];
      const entry = Object.entries(this.state.pending).find(([, p]) => p.expires > this.now() && code && p.hash === hash(code));
      if (entry) {
        const [botId, p] = entry;
        if (!this.options.hooks.exists(botId) || (p.owner && p.owner !== m.from.id)) return;
        p.owner = m.from.id; this.save();
        await this.call(this.options.managerToken!, 'sendMessage', { chat_id: m.chat.id, text: 'create your telegram bot to finish connecting. keep the suggested username so bos can securely match it.', reply_markup: { inline_keyboard: [[{ text: `connect ${p.name}`, url: `https://t.me/newbot/${this.manager!.username}/${p.username}?name=${encodeURIComponent(p.name)}` }]] } });
      }
    }
    if (!u.managed_bot) return;
    const { user, bot } = u.managed_bot;
    // Ownership changes revoke a connection; they never transfer BOS authority.
    for (const [id, c] of Object.entries(this.state.connections)) if (c.id === bot.id) {
      this.tokens.delete(bot.id);
      if (c.owner !== user.id) this.disconnect(id);
      return;
    }
    const entry = Object.entries(this.state.pending).find(([, p]) => p.owner === user.id && p.username === bot.username && p.expires > this.now());
    if (!entry || !bot.is_bot || !this.options.hooks.exists(entry[0])) return;
    const [botId] = entry;
    this.state.connections[botId] = { id: bot.id, username: bot.username!, owner: user.id, members: [user.id], groups: [], offset: 0, connectedAt: this.now() };
    delete this.state.pending[botId]; this.save();
    await this.call(this.options.managerToken!, 'sendMessage', { chat_id: user.id, text: 'connected. open your bot and tap start.', reply_markup: { inline_keyboard: [[{ text: 'open bot', url: `https://t.me/${bot.username}` }]] } });
  }
  private async token(c: Connection) {
    let token = this.tokens.get(c.id);
    if (!token) { token = await this.call<string>(this.options.managerToken!, 'getManagedBotToken', { user_id: c.id }); this.tokens.set(c.id, token); }
    return token;
  }
  private async pollConnection(botId: string) {
    const c = this.state.connections[botId];
    if (!this.options.hooks.exists(botId)) { this.disconnect(botId); return; }
    const token = await this.token(c);
    const updates = await this.call<TelegramUpdate[]>(token, 'getUpdates', { offset: c.offset, timeout: 20, limit: 50, allowed_updates: ['message'] });
    if (this.stopped || this.state.connections[botId] !== c) return;
    for (const u of updates) {
      if (this.stopped || this.state.connections[botId] !== c) return;
      await this.handleMessage(botId, u);
      if (this.stopped || this.state.connections[botId] !== c) return;
      c.offset = u.update_id + 1; this.save();
    }
  }
  async handleMessage(botId: string, u: TelegramUpdate) {
    const c = this.state.connections[botId], m = u.message;
    if (!c || !m?.from || m.from.is_bot || m.sender_chat || !['private','group','supergroup'].includes(m.chat.type)) return;
    const privateChat = m.chat.type === 'private';
    if (privateChat && m.from.id !== m.chat.id) return;
    const text = m.text ?? m.caption ?? '';
    const current = () => this.state.connections[botId] === c && this.options.hooks.exists(botId);
    const send = async (text: string) => { const token = await this.token(c); if (current()) await this.call(token, 'sendMessage', { chat_id: m.chat.id, text }); };
    const invite = this.state.invites[botId], code = text.match(/^\/start ([\w-]+)$/)?.[1];
    if (privateChat && code && invite?.expires > this.now() && invite.hash === hash(code)) {
      if (!c.members.includes(m.from.id)) c.members.push(m.from.id);
      delete this.state.invites[botId]; this.save(); await send('connected. you can now talk to this bot.'); return;
    }
    if (!c.members.includes(m.from.id)) return;
    if (!privateChat) {
      const addressed = text.toLowerCase().includes(`@${c.username.toLowerCase()}`) || m.reply_to_message?.from?.id === c.id;
      if (!addressed) return;
      if (text.toLowerCase() === `/connect@${c.username.toLowerCase()}` && m.from.id === c.owner) {
        const member = await this.call<{status: string}>(await this.token(c), 'getChatMember', { chat_id: m.chat.id, user_id: m.from.id });
        if (!current() || !['creator','administrator'].includes(member.status)) return;
        if (!c.groups.includes(m.chat.id)) c.groups.push(m.chat.id);
        this.save(); await send('connected. invited people can mention me or reply to my messages here.'); return;
      }
      if (!c.groups.includes(m.chat.id)) return;
    }
    if (text === '/start') { await send('connected. send me a message here.'); return; }
    if (!current()) return;
    if (!text.trim()) { await send('this channel currently accepts text. add a message with your request.'); return; }
    const id = `tg-${c.id}-${u.update_id}`;
    if (this.state.jobs.some(j => j.id === id)) return;
    if (this.state.jobs.filter(j => j.botId === botId && ['queued','running'].includes(j.phase)).length >= 20) { await send('the queue is full. please try again after the current work finishes.'); return; }
    this.state.jobs.push({ id, botId, actor: m.from.id, chatId: m.chat.id, topic: m.message_thread_id, messageId: m.message_id, text, phase: 'queued' });
    this.save();
  }
  private drain(botId: string) {
    if (this.running.has(botId)) return;
    const job = this.state.jobs.find(j => j.botId === botId && j.phase === 'queued');
    if (!job) return;
    this.running.add(botId);
    void this.deliver(job).finally(() => this.running.delete(botId));
  }
  private async deliver(job: Job) {
    const c = this.state.connections[job.botId];
    const active = () => !this.stopped && this.state.connections[job.botId] === c && c.members.includes(job.actor) && this.options.hooks.exists(job.botId);
    if (!active()) return;
    job.phase = 'running'; this.save();
    try {
      const token = await this.token(c);
      if (!active()) return;
      const sent = await this.call<{message_id: number}>(token, 'sendMessage', { chat_id: job.chatId, message_thread_id: job.topic, text: 'working…', reply_parameters: { message_id: job.messageId } });
      let last = 'working…';
      const progress = async (text: string) => {
        const rendered = text.slice(0, 4000);
        if (!active() || rendered === last) return;
        await this.call(token, 'editMessageText', { chat_id: job.chatId, message_id: sent.message_id, text: rendered }); last = rendered;
      };
      const reply = await this.options.hooks.run(job, active, progress);
      if (!active()) return;
      const chunks = reply.text.match(/[\s\S]{1,4000}/g) ?? ['finished without a text reply. open bos for details.'];
      await progress(chunks[0]);
      for (const text of chunks.slice(1)) { if (!active()) return; await this.call(token, 'sendMessage', { chat_id: job.chatId, message_thread_id: job.topic, text, reply_parameters: { message_id: job.messageId } }); }
      job.phase = 'done';
    } catch { job.phase = 'interrupted'; c.error = 'a delivery was interrupted; check bos before sending the request again'; }
    finally { if (job.phase === 'running') job.phase = 'interrupted'; this.save(); }
  }
}
