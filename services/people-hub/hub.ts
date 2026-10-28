/** BOS people hub: an always-on meeting point so two BOS homes that cannot
 * reach each other (a Mac behind NAT, a free app.bosbot.my VM) can still be
 * friends. Every home dials out with its own token; nothing here dials in.
 *
 * A home's identity is its local owner contact id (`<homeId>:person:owner`),
 * so room messages carry the same ids the local app already uses for "me".
 * Rooms reuse the canonical room store. Bots never run here: a message that
 * tags a bot becomes a job its owner's home long-polls, runs locally in Ask
 * mode, and answers back. Only the conversation itself travels. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SharedRoomRepository } from "../../server/shared-room-repository.ts";
import { SharedTyping } from "../../server/shared-typing.ts";
import { writeFileAtomic } from "../../server/atomic.ts";
import { contactId, parseContactId, type SharedAttachment, type SharedRoom, type SharedTextMessage } from "../../shared/multiplayer.ts";
import { sharedMentionTargets, sharedMentionText } from "../../shared/shared-mentions.ts";
import { groupReplyTargets } from "../../shared/group-replies.ts";
import { sharedRequestId } from "../../server/shared-request-store.ts";
import type { SharedRequest } from "../../shared/shared-request.ts";

export const HUB_HOME_ID = "bosbot-people";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DAY = 24 * 60 * 60_000;
const INVITE_TTL = 30 * DAY;
const INVITE_MAX_USES = 25;
const JOB_TTL = 20 * 60_000;
const ONLINE_WINDOW = 90_000;

export interface HubBot { localId: string; name: string; title?: string; color?: string; mascotBody?: string | null; mascotEyes?: string | null }
interface Home { homeId: string; tokenHash: string; name: string; createdAt: number; lastSeen: number; bots: HubBot[] }
interface Invite { hash: string; homeId: string; createdAt: number; expiresAt: number; uses: number; email?: string }
interface Job extends SharedRequest { homeId: string; claimedAt?: number }
interface State { version: 1; homes: Home[]; invites: Invite[]; connections: Array<[string, string]>; jobs: Job[] }
interface Note { seq: number; roomId: string; roomName: string; senderId: string; senderName: string; text: string; at: number }

export interface HubOptions {
  dataDir: string;
  publicOrigin: string;
  /** Sends one invitation email. Tests inject a recorder. */
  sendEmail?: (to: string, subject: string, html: string, text: string) => Promise<void>;
  now?: () => number;
  limits?: Partial<typeof DEFAULT_LIMITS>;
  /** Home of the BOS Bot founder. Every other home can join it as a contact
   * through POST /hub/v1/founder, so the founder can talk to users in the app. */
  founderHomeId?: string;
}
const DEFAULT_LIMITS = { registerPerIpHour: 10, homes: 20_000, invitesPerHomeDay: 100, emailsPerHomeDay: 20, emailsPerDay: 500, acceptPerIpHour: 40 };

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ownerOf = (homeId: string) => `${homeId}:person:owner`;
const homeOf = (id: string) => parseContactId(id)?.homeId ?? "";
const isPerson = (id: unknown) => parseContactId(id)?.kind === "person";
const isBot = (id: unknown) => parseContactId(id)?.kind === "bot";
const cleanName = (value: unknown, fallback: string) => typeof value === "string" && value.trim() ? value.trim().slice(0, 80) : fallback;

const SAFE_TYPES: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "text/markdown": "md", "application/json": "json",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export class PeopleHub {
  readonly rooms: SharedRoomRepository;
  private readonly typing = new SharedTyping();
  private readonly stateFile: string;
  private readonly attachmentDir: string;
  private state: State;
  private readonly tokens = new Map<string, Home>();
  private readonly notes = new Map<string, Note[]>();
  private noteSeq = 0;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly counters = new Map<string, { count: number; resetAt: number }>();
  private readonly attachments = new Map<string, { roomId: string; actorId: string; attachment: SharedAttachment; at: number }>();
  private readonly opts: HubOptions;
  private readonly limits: typeof DEFAULT_LIMITS;
  private readonly now: () => number;

  constructor(opts: HubOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
    mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    this.stateFile = join(opts.dataDir, "hub-state.json");
    this.attachmentDir = join(opts.dataDir, "attachments");
    this.rooms = new SharedRoomRepository(join(opts.dataDir, "rooms.json"), HUB_HOME_ID);
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, "utf8")) as State : { version: 1, homes: [], invites: [], connections: [], jobs: [] };
    for (const home of this.state.homes) this.tokens.set(home.tokenHash, home);
    const index = join(this.attachmentDir, "index.json");
    if (existsSync(index)) for (const [id, item] of Object.entries(JSON.parse(readFileSync(index, "utf8")) as Record<string, never>)) this.attachments.set(id, item);
  }

  private save(): void { writeFileAtomic(this.stateFile, JSON.stringify(this.state), { mode: 0o600 }); }

  private limit(key: string, max: number, windowMs: number): void {
    const now = this.now();
    const entry = this.counters.get(key);
    if (!entry || entry.resetAt <= now) { this.counters.set(key, { count: 1, resetAt: now + windowMs }); return; }
    if (entry.count >= max) throw new HttpError(429, "too many requests; try again later");
    entry.count++;
  }

  home(homeId: string): Home | undefined { return this.state.homes.find(home => home.homeId === homeId); }
  private online(homeId: string): boolean { return (this.home(homeId)?.lastSeen ?? 0) > this.now() - ONLINE_WINDOW; }
  nameOf(id: string): string {
    const key = parseContactId(id);
    if (!key) return "Member";
    const home = this.home(key.homeId);
    if (key.kind === "person") return home?.name ?? "Member";
    return home?.bots.find(bot => bot.localId === key.localId)?.name ?? "Bot";
  }
  private connected(a: string, b: string): boolean {
    return this.state.connections.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  }
  private friendsOf(homeId: string): string[] {
    return this.state.connections.flatMap(([x, y]) => x === homeId ? [y] : y === homeId ? [x] : []);
  }
  private publishedBot(id: string): HubBot | undefined {
    const key = parseContactId(id);
    return key?.kind === "bot" ? this.home(key.homeId)?.bots.find(bot => bot.localId === key.localId) : undefined;
  }

  // ── home lifecycle ──────────────────────────────────────────────────
  register(homeId: unknown, name: unknown, ip: string): { token: string; actorId: string } {
    if (typeof homeId !== "string" || !ID.test(homeId) || homeId === HUB_HOME_ID) throw new HttpError(400, "invalid home id");
    this.limit(`register:${ip}`, this.limits.registerPerIpHour, 60 * 60_000);
    if (this.home(homeId)) throw new HttpError(409, "this home is already registered");
    if (this.state.homes.length >= this.limits.homes) throw new HttpError(503, "registration is closed for now");
    const token = `bph_${randomBytes(32).toString("base64url")}`;
    const home: Home = { homeId, tokenHash: hash(token), name: cleanName(name, "BOS Bot user"), createdAt: this.now(), lastSeen: this.now(), bots: [] };
    this.state.homes.push(home);
    this.save();
    this.tokens.set(home.tokenHash, home);
    return { token, actorId: ownerOf(homeId) };
  }

  authenticate(header: string | undefined): Home {
    const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const home = token.startsWith("bph_") ? this.tokens.get(hash(token)) : undefined;
    if (!home) throw new HttpError(401, "hub sign-in required");
    home.lastSeen = this.now();
    return home;
  }

  setProfile(home: Home, body: Record<string, unknown>): { name: string } {
    home.name = cleanName(body.name, home.name);
    this.save();
    return { name: home.name };
  }

  setBots(home: Home, raw: unknown): { bots: number } {
    if (!Array.isArray(raw) || raw.length > 100) throw new HttpError(400, "bots list required");
    const str = (value: unknown, max: number) => typeof value === "string" && value.length <= max ? value : undefined;
    home.bots = raw.flatMap((item): HubBot[] => {
      if (!item || typeof item !== "object" || typeof item.localId !== "string" || !ID.test(item.localId)) return [];
      return [{ localId: item.localId, name: cleanName(item.name, "Bot"), title: str(item.title, 120), color: str(item.color, 40),
        mascotBody: str(item.mascotBody, 40) ?? null, mascotEyes: str(item.mascotEyes, 40) ?? null }];
    });
    this.save();
    return { bots: home.bots.length };
  }

  // ── invites ─────────────────────────────────────────────────────────
  async createInvite(home: Home, body: Record<string, unknown>): Promise<{ url: string; token: string; emailed: boolean; expiresAt: number }> {
    this.limit(`invite:${home.homeId}`, this.limits.invitesPerHomeDay, DAY);
    const email = typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : undefined;
    if (email && (!/^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[a-z]{2,24}$/i.test(email))) throw new HttpError(400, "that email address looks wrong");
    const token = randomBytes(18).toString("base64url");
    const invite: Invite = { hash: hash(token), homeId: home.homeId, createdAt: this.now(), expiresAt: this.now() + INVITE_TTL, uses: 0, ...(email ? { email } : {}) };
    const url = `${this.opts.publicOrigin}/i/${token}`;
    let emailed = false;
    if (email) {
      if (!this.opts.sendEmail) throw new HttpError(503, "email invites are not available; copy the link instead");
      this.limit(`email:${home.homeId}`, this.limits.emailsPerHomeDay, DAY);
      this.limit("email:all", this.limits.emailsPerDay, DAY);
      const who = home.name;
      const html = `<p>${escapeHtml(who)} invited you to chat on BOS Bot, where you can message each other and bring your AI bots into the conversation.</p>`
        + `<p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#111;color:#fff;border-radius:8px;text-decoration:none">Accept the invite</a></p>`
        + `<p style="color:#666;font-size:13px">Or click Add a friend in BOS Bot's chat list and paste this link: ${url}</p>`;
      try { await this.opts.sendEmail(email, `${who} invited you to BOS Bot`, html, `${who} invited you to chat on BOS Bot.\n\nAccept: ${url}\n`); }
      catch { throw new HttpError(502, "the invite email did not send; copy the link instead"); }
      emailed = true;
    }
    this.state.invites = this.state.invites.filter(item => item.expiresAt > this.now());
    this.state.invites.push(invite);
    this.save();
    return { url, token, emailed, expiresAt: invite.expiresAt };
  }

  private inviteFor(token: unknown): Invite {
    const invite = typeof token === "string" && /^[\w-]{10,64}$/.test(token) ? this.state.invites.find(item => item.hash === hash(token)) : undefined;
    if (!invite || invite.expiresAt <= this.now() || invite.uses >= INVITE_MAX_USES || !this.home(invite.homeId)) throw new HttpError(404, "this invite link has expired; ask for a new one");
    return invite;
  }

  previewInvite(token: unknown): { from: string } { return { from: this.home(this.inviteFor(token).homeId)!.name }; }

  acceptInvite(home: Home, token: unknown, ip: string): { room: SharedRoom; contact: { id: string; name: string; kind: "person" } } {
    this.limit(`accept:${ip}`, this.limits.acceptPerIpHour, 60 * 60_000);
    const invite = this.inviteFor(token);
    if (invite.homeId === home.homeId) throw new HttpError(400, "this is your own invite link; send it to a friend");
    if (!this.connected(invite.homeId, home.homeId)) {
      this.state.connections.push([invite.homeId, home.homeId]);
      invite.uses++;
      this.save();
    }
    const room = this.direct(ownerOf(home.homeId), ownerOf(invite.homeId));
    return { room, contact: { id: ownerOf(invite.homeId), name: this.home(invite.homeId)!.name, kind: "person" } };
  }

  /** Connects this home to the founder's home and opens their direct room.
   * 404 until the founder's own home has registered, so apps retry later. */
  joinFounder(home: Home): { self: true } | { room: SharedRoom; contact: { id: string; name: string; kind: "person" } } {
    const founderId = this.opts.founderHomeId;
    const founder = founderId ? this.home(founderId) : undefined;
    if (!founder) throw new HttpError(404, "no founder contact yet");
    if (founder.homeId === home.homeId) return { self: true };
    if (!this.connected(founder.homeId, home.homeId)) {
      this.state.connections.push([founder.homeId, home.homeId]);
      this.save();
    }
    const room = this.direct(ownerOf(home.homeId), ownerOf(founder.homeId));
    return { room, contact: { id: ownerOf(founder.homeId), name: founder.name, kind: "person" } };
  }

  private direct(actorId: string, targetId: string): SharedRoom {
    const existing = this.rooms.listFor(actorId).find(room => room.kind !== "group" && room.memberIds.length === 2 && room.memberIds.includes(targetId));
    return existing ?? this.rooms.create("Direct message", [actorId, targetId], this.now(), actorId, "direct");
  }

  // ── contacts & rooms ────────────────────────────────────────────────
  contacts(home: Home) {
    const actorId = ownerOf(home.homeId);
    const people = new Set(this.friendsOf(home.homeId).map(ownerOf));
    const bots = new Set<string>();
    for (const room of this.rooms.listFor(actorId)) for (const id of room.memberIds) {
      if (isPerson(id) && id !== actorId) people.add(id);
      if (isBot(id) && homeOf(id) !== home.homeId) bots.add(id);
    }
    return [
      ...[...people].map(id => ({ id, name: this.nameOf(id), kind: "person" as const, homeId: homeOf(id), hub: true,
        connected: this.connected(home.homeId, homeOf(id)), online: this.online(homeOf(id)) })),
      ...[...bots].flatMap(id => {
        const bot = this.publishedBot(id);
        return bot ? [this.botContact(id, bot)] : [];
      }),
    ];
  }

  private botContact(id: string, bot: HubBot) {
    return { id, name: bot.name, kind: "bot" as const, homeId: homeOf(id), title: bot.title, color: bot.color, mascotBody: bot.mascotBody ?? null,
      mascotEyes: bot.mascotEyes ?? null, avatarUrl: null, avatarCrop: "mascot", remote: true, hub: true, ownerName: this.nameOf(ownerOf(homeOf(id))) };
  }

  /** Bots an actor may set working in a room: their own published bots
   * anywhere they are a member, plus bots their owners added to the room. */
  roomBots(room: SharedRoom, actorId: string) {
    const own = (this.home(homeOf(actorId))?.bots ?? []).map(bot => contactId({ homeId: homeOf(actorId), kind: "bot", localId: bot.localId }));
    const ids = [...new Set([...own, ...room.memberIds.filter(isBot)])];
    return ids.flatMap(id => {
      const bot = this.publishedBot(id);
      if (!bot) return [];
      const key = parseContactId(id)!;
      return [{ key: { homeId: key.homeId, kind: "bot" as const, localId: key.localId }, id, name: bot.name, color: bot.color, mascotBody: bot.mascotBody ?? null,
        mascotEyes: bot.mascotEyes ?? null, avatarUrl: null, avatarCrop: "mascot", remote: key.homeId !== homeOf(actorId),
        ownerName: this.nameOf(ownerOf(key.homeId)), availability: this.online(key.homeId) ? "ready" as const : "offline" as const }];
    });
  }

  private allowedNewMembers(home: Home): Set<string> {
    return new Set([...this.friendsOf(home.homeId).map(ownerOf), ...home.bots.map(bot => contactId({ homeId: home.homeId, kind: "bot", localId: bot.localId }))]);
  }

  createRoom(home: Home, body: Record<string, unknown>): SharedRoom {
    const actorId = ownerOf(home.homeId);
    if (typeof body.name !== "string" || !Array.isArray(body.memberIds)) throw new HttpError(400, "room name and members required");
    if (!body.memberIds.includes(actorId)) throw new HttpError(403, "sender must be a member");
    const allowed = this.allowedNewMembers(home);
    if (body.memberIds.some(id => id !== actorId && (typeof id !== "string" || !allowed.has(id)))) throw new HttpError(403, "add people you are connected with and your own bots");
    try { return this.rooms.create(body.name, body.memberIds as string[], this.now(), actorId, "group"); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "invalid room"); }
  }

  patchRoom(home: Home, room: SharedRoom, body: Record<string, unknown>): SharedRoom {
    const actorId = ownerOf(home.homeId);
    if (!Number.isSafeInteger(body.revision)) throw new HttpError(400, "room revision required");
    if (body.name === undefined && body.memberIds === undefined) throw new HttpError(400, "name or members required");
    if (body.name !== undefined && typeof body.name !== "string") throw new HttpError(400, "invalid room name");
    if (body.memberIds !== undefined) {
      if (room.kind !== "group") throw new HttpError(400, "start a group to add more people");
      if (!Array.isArray(body.memberIds) || !body.memberIds.includes(actorId)) throw new HttpError(400, "you must remain a member; use leave to exit");
      const next = new Set(body.memberIds as string[]);
      const added = [...next].filter(id => !room.memberIds.includes(id));
      const removed = room.memberIds.filter(id => !next.has(id));
      const allowed = this.allowedNewMembers(home);
      if (added.some(id => !allowed.has(id))) throw new HttpError(403, "add people you are connected with and your own bots");
      const creator = room.createdBy === actorId;
      if (!creator && [...added, ...removed].some(id => homeOf(id) !== home.homeId || !isBot(id))) throw new HttpError(403, "only the group creator can change its people; you can add or remove your own bots");
      // A person who leaves the group takes their bots with them.
      const gone = new Set(removed.filter(isPerson).map(homeOf));
      body.memberIds = [...next].filter(id => !(isBot(id) && gone.has(homeOf(id))));
    }
    try { return this.rooms.updateRoom(room.id, actorId, body.revision as number, { name: body.name as string | undefined, memberIds: body.memberIds as string[] | undefined }); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "room changed"); }
  }

  leaveRoom(home: Home, room: SharedRoom, body: Record<string, unknown>): SharedRoom {
    const actorId = ownerOf(home.homeId);
    if (room.kind !== "group") throw new HttpError(400, "leave is available for group chats");
    if (!Number.isSafeInteger(body.revision)) throw new HttpError(400, "room revision required");
    const rest = room.memberIds.filter(id => homeOf(id) !== home.homeId);
    if (!rest.some(isPerson)) throw new HttpError(400, "delete this group to leave as its last member");
    try { return this.rooms.updateRoom(room.id, actorId, body.revision as number, { memberIds: rest }); }
    catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "room changed"); }
  }

  preferences(room: SharedRoom, actorId: string) {
    const preference = this.rooms.preferencesFor(room.id, actorId);
    return { ...preference, replyBotIds: groupReplyTargets({ actorId, preference, available: this.roomBots(room, actorId).map(bot => bot.id),
      explicitBots: [], humanMentions: [], history: this.rooms.allMessages(room.id) }) };
  }

  postMessage(home: Home, room: SharedRoom, body: Record<string, unknown>): { message: SharedTextMessage; created: boolean } {
    const actorId = ownerOf(home.homeId);
    if (typeof body.text !== "string" || typeof body.sendId !== "string") throw new HttpError(400, "text and sendId required");
    if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some(item => !this.ownsAttachment(room.id, actorId, item)))) {
      throw new HttpError(403, "attachment is not owned by this room member");
    }
    const previous = this.rooms.allMessages(room.id).find(message => message.sendId === body.sendId && contactId(message.actor) === actorId);
    const available = this.roomBots(room, actorId);
    const people = room.memberIds.filter(isPerson).map(id => ({ id, name: this.nameOf(id), kind: "person" as const }));
    const mentioned = sharedMentionTargets(body.text, [...people, ...available.map(bot => ({ id: bot.id, name: bot.name, kind: "bot" as const, ownerName: bot.ownerName }))]);
    const targets = available.filter(bot => mentioned.includes(bot.id)).map(bot => bot.id);
    const humanMentions = /(^|\s)@everyone\b/i.test(sharedMentionText(body.text)) ? people.map(person => person.id) : people.filter(person => mentioned.includes(person.id)).map(person => person.id);
    if (!previous && body.botTargets !== undefined && (!Array.isArray(body.botTargets) || body.botTargets.some(id => typeof id !== "string" || !targets.includes(id)))) {
      throw new HttpError(403, "bot mention is unavailable; choose it again");
    }
    const explicit = (body.botTargets as string[] | undefined) ?? targets;
    const botTargets = previous?.botTargets ?? (room.kind !== "group" || (targets.length > 0 && explicit.length === 0) ? explicit : groupReplyTargets({
      actorId, preference: this.rooms.preferencesFor(room.id, actorId), available: available.map(bot => bot.id), explicitBots: explicit, humanMentions, history: this.rooms.allMessages(room.id),
    }));
    let result;
    try {
      result = this.rooms.append(room.id, actorId, { actor: parseContactId(actorId), text: body.text, sendId: body.sendId, attachments: body.attachments,
        ...(botTargets.length ? { botTargets } : {}), replyTo: body.replyTo, humanMentions: previous?.humanMentions ?? humanMentions }, this.now());
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "invalid message"); }
    this.typing.update(room.id, actorId, false);
    if (result.created) {
      this.notify(room, result.message);
      for (const botId of result.message.botTargets ?? []) this.queueJob(room, result.message, botId);
    }
    return result;
  }

  private notify(room: SharedRoom, message: SharedTextMessage): void {
    const senderId = contactId(message.actor);
    for (const memberId of room.memberIds) {
      if (!isPerson(memberId) || memberId === senderId || message.kind === "activity") continue;
      const preference = this.rooms.preferencesFor(room.id, memberId).notifications;
      if (preference === "muted" || (preference === "mentions" && !message.humanMentions?.includes(memberId))) continue;
      const list = this.notes.get(homeOf(memberId)) ?? [];
      list.push({ seq: ++this.noteSeq, roomId: room.id, roomName: room.name, senderId, senderName: this.nameOf(senderId),
        text: (message.text || (message.attachments?.length ? "Sent an attachment" : "New message")).slice(0, 300), at: message.at });
      this.notes.set(homeOf(memberId), list.slice(-100));
      this.wake(homeOf(memberId));
    }
  }

  // ── bot jobs ────────────────────────────────────────────────────────
  private queueJob(room: SharedRoom, source: SharedTextMessage, botId: string): void {
    const bot = this.publishedBot(botId);
    if (!bot) return;
    const homeId = homeOf(botId);
    const id = sharedRequestId(room.id, source.id, botId);
    if (this.state.jobs.some(job => job.id === id)) return;
    this.state.jobs = this.state.jobs.filter(job => job.updatedAt > this.now() - 7 * DAY);
    this.state.jobs.push({ id, homeId, roomId: room.id, roomRevision: room.revision ?? 1, sourceId: source.id, requesterId: contactId(source.actor), botId,
      botName: bot.name, ownerId: ownerOf(homeId), ownerName: this.nameOf(ownerOf(homeId)), state: this.online(homeId) ? "accepted" : "offline",
      createdAt: this.now(), updatedAt: this.now() });
    this.save();
    this.wake(homeId);
  }

  private expireJobs(): void {
    let changed = false;
    for (const job of this.state.jobs) {
      if (["accepted", "queued", "working", "offline"].includes(job.state) && job.createdAt < this.now() - JOB_TTL) {
        job.state = job.state === "working" ? "outcome-unknown" : "offline"; job.updatedAt = this.now(); changed = true;
      }
    }
    if (changed) this.save();
  }

  events(home: Home, after: number): { cursor: number; jobs: Job[]; notifications: Note[] } {
    this.expireJobs();
    // A job queued while its home was offline still runs once it returns.
    const jobs = this.state.jobs.filter(job => job.homeId === home.homeId && (job.state === "accepted" || (job.state === "offline" && job.createdAt > this.now() - JOB_TTL)));
    const notes = after < 0 ? [] : (this.notes.get(home.homeId) ?? []).filter(note => note.seq > after);
    return { cursor: this.noteSeq, jobs, notifications: notes };
  }

  waitForEvents(home: Home, after: number, waitMs: number): Promise<ReturnType<PeopleHub["events"]>> {
    const ready = this.events(home, after);
    if (ready.jobs.length || ready.notifications.length || waitMs <= 0) return Promise.resolve(ready);
    return new Promise(resolve => {
      const set = this.waiters.get(home.homeId) ?? new Set();
      const done = () => { clearTimeout(timer); set.delete(done); resolve(this.events(home, after)); };
      const timer = setTimeout(done, waitMs);
      set.add(done);
      this.waiters.set(home.homeId, set);
    });
  }

  private wake(homeId: string): void { for (const done of [...(this.waiters.get(homeId) ?? [])]) done(); }

  private job(home: Home, id: string): Job {
    const job = this.state.jobs.find(item => item.id === id && item.homeId === home.homeId);
    if (!job) throw new HttpError(404, "job unavailable");
    return job;
  }

  claimJob(home: Home, id: string) {
    const job = this.job(home, id);
    if (job.state !== "accepted" && job.state !== "offline") throw new HttpError(409, "job already taken");
    const all = this.rooms.allMessages(job.roomId);
    const source = all.find(message => message.id === job.sourceId);
    const room = this.rooms.allRooms().find(item => item.id === job.roomId);
    if (!source || !room || !room.memberIds.includes(job.requesterId)) { this.finish(job, "failed", "This conversation changed before the bot could start."); throw new HttpError(410, "job source unavailable"); }
    job.state = "working"; job.claimedAt = job.dispatchedAt = job.updatedAt = this.now();
    this.save();
    const names = (id: string) => this.nameOf(id);
    const recent = all.filter(message => message.sequence < source.sequence && message.kind !== "activity" && !message.deletedAt && message.text).slice(-9)
      .map(message => ({ name: names(contactId(message.actor)), kind: message.actor.kind, text: message.text.slice(0, 600) }));
    const quoted = source.replyTo ? all.find(message => message.id === source.replyTo) : undefined;
    return {
      job,
      room: { id: room.id, name: room.kind === "group" ? room.name : `${names(job.requesterId)} and ${names(job.ownerId)}`, kind: room.kind ?? "direct", revision: room.revision ?? 1 },
      members: room.memberIds.map(memberId => ({ id: memberId, name: names(memberId), kind: parseContactId(memberId)!.kind, ...(isBot(memberId) ? { ownerName: names(ownerOf(homeOf(memberId))) } : {}) })),
      source: { id: source.id, text: source.text, at: source.at, attachments: source.attachments ?? [] },
      senderName: names(job.requesterId),
      requesterIsOwner: job.requesterId === job.ownerId,
      recent,
      ...(quoted ? { replyTo: { name: names(contactId(quoted.actor)), text: quoted.deletedAt ? "Message removed" : quoted.text.slice(0, 4000) } } : {}),
    };
  }

  jobActivity(home: Home, id: string, body: Record<string, unknown>) {
    const job = this.job(home, id);
    if (job.state !== "working") throw new HttpError(409, "job is not running");
    const key = parseContactId(job.botId)!;
    if (typeof body.sendId !== "string" || !ID.test(body.sendId)) throw new HttpError(400, "sendId required");
    try { return this.rooms.append(job.roomId, job.botId, { actor: key, kind: "activity", text: "", tool: body.tool, sendId: body.sendId, responseTo: job.sourceId }, this.now()); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "invalid activity"); }
  }

  jobReply(home: Home, id: string, body: Record<string, unknown>) {
    const job = this.job(home, id);
    if (job.state !== "working" && job.state !== "outcome-unknown") throw new HttpError(409, "job is not running");
    const key = parseContactId(job.botId)!;
    const room = this.rooms.allRooms().find(item => item.id === job.roomId);
    if (!room) throw new HttpError(410, "conversation unavailable");
    const files = Array.isArray(body.files) ? body.files.slice(0, 4) : [];
    const attachments = files.flatMap(file => {
      try { return [this.saveAttachment(room.id, job.botId, file?.name, file?.mime, file?.data)]; } catch { return []; }
    });
    const text = typeof body.text === "string" ? body.text.slice(0, 20_000) : "";
    if (!text.trim() && !attachments.length) { this.finish(job, "completed"); return { message: null }; }
    let result;
    try {
      result = this.rooms.append(room.id, job.botId, { actor: key, text: text || " ", sendId: `reply-${job.sourceId}-${key.localId}`, responseTo: job.sourceId,
        ...(attachments.length ? { attachments } : {}) }, this.now());
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "invalid reply"); }
    this.finish(job, "completed", undefined, result.message.id);
    if (result.created) this.notify(room, result.message);
    return result;
  }

  jobFail(home: Home, id: string, body: Record<string, unknown>) {
    const job = this.job(home, id);
    const explanation = typeof body.explanation === "string" && body.explanation.trim() ? body.explanation.trim().slice(0, 500) : `${job.botName} could not finish that reply. Please try again.`;
    this.finish(job, "failed", explanation);
    const key = parseContactId(job.botId)!;
    try { this.rooms.append(job.roomId, job.botId, { actor: key, text: "", kind: "activity", tool: { name: "reply failed", ok: false, spoken: explanation },
      sendId: `failed-${job.sourceId}-${key.localId}`, responseTo: job.sourceId }, this.now()); } catch { /* room gone */ }
    return { request: job };
  }

  jobState(home: Home, id: string) { return { request: this.job(home, id) }; }

  private finish(job: Job, state: SharedRequest["state"], explanation?: string, resultId?: string): void {
    job.state = state; job.updatedAt = this.now();
    if (explanation) job.explanation = explanation;
    if (resultId) job.resultId = resultId;
    this.save();
  }

  requests(room: SharedRoom, url: URL) {
    const sequences = new Map(this.rooms.allMessages(room.id).map(message => [message.id, message.sequence]));
    const before = Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
    const all = this.state.jobs.filter(job => job.roomId === room.id && (sequences.get(job.sourceId) ?? Infinity) < before)
      .sort((a, b) => sequences.get(b.sourceId)! - sequences.get(a.sourceId)!);
    const requests = all.slice(0, 50).map(({ homeId: _home, claimedAt: _claimed, ...job }) => ({ ...job, sourceSequence: sequences.get(job.sourceId), resultSequence: job.resultId ? sequences.get(job.resultId) : undefined }));
    return { requests, hasMore: all.length > requests.length };
  }

  cancelRequest(home: Home, room: SharedRoom, id: string) {
    const actorId = ownerOf(home.homeId);
    const job = this.state.jobs.find(item => item.id === id && item.roomId === room.id);
    if (!job) throw new HttpError(404, "request unavailable");
    if (job.requesterId !== actorId && job.ownerId !== actorId) throw new HttpError(403, "only the requester or bot owner can stop this request");
    if (["accepted", "queued", "working", "offline"].includes(job.state)) { job.cancelledBy = actorId; this.finish(job, "cancelled"); }
    return { request: job };
  }

  // ── attachments ─────────────────────────────────────────────────────
  saveAttachment(roomId: string, actorId: string, name: unknown, mime: unknown, data: unknown): SharedAttachment {
    if (typeof name !== "string" || !name || name.length > 255 || /[\\/\x00-\x1f]/.test(name) || typeof mime !== "string" || !SAFE_TYPES[mime] ||
        typeof data !== "string" || data.length > 14_000_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new HttpError(400, "invalid attachment");
    const bytes = Buffer.from(data, "base64");
    if (bytes.length < 1 || bytes.length > 10 * 1024 * 1024) throw new HttpError(400, "files must be under 10 MB here");
    const recent = [...this.attachments.values()].filter(item => item.actorId === actorId && item.at > this.now() - DAY);
    if (recent.length >= 100 || recent.reduce((total, item) => total + item.attachment.size, 0) + bytes.length > 200 * 1024 * 1024) throw new HttpError(429, "daily file limit reached");
    const id = randomUUID();
    const attachment = { id, name: `${name.replace(/\.[^.]+$/, "").slice(0, 200).trim() || "attachment"}.${SAFE_TYPES[mime]}`, mime, size: bytes.length };
    mkdirSync(this.attachmentDir, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(this.attachmentDir, id), data, { mode: 0o600 });
    this.attachments.set(id, { roomId, actorId, attachment, at: this.now() });
    writeFileAtomic(join(this.attachmentDir, "index.json"), JSON.stringify(Object.fromEntries(this.attachments)), { mode: 0o600 });
    return attachment;
  }

  private ownsAttachment(roomId: string, actorId: string, value: unknown): boolean {
    const item = value && typeof value === "object" ? this.attachments.get((value as SharedAttachment).id) : undefined;
    return Boolean(item && item.roomId === roomId && item.actorId === actorId && JSON.stringify(item.attachment) === JSON.stringify({ id: item.attachment.id, name: (value as SharedAttachment).name, mime: (value as SharedAttachment).mime, size: (value as SharedAttachment).size }));
  }

  attachment(roomId: string, id: string) {
    const item = this.attachments.get(id);
    if (!item || item.roomId !== roomId) return null;
    return { attachment: item.attachment, data: readFileSync(join(this.attachmentDir, id), "utf8") };
  }

  // ── HTTP ────────────────────────────────────────────────────────────
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://hub.invalid");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const ip = String(req.headers["cf-connecting-ip"] ?? req.socket.remoteAddress ?? "unknown");
    try {
      if (method === "GET" && path === "/healthz") return send(res, 200, { ok: true, service: "bos-people-hub" });
      let m = /^\/i\/([\w-]{10,64})$/.exec(path);
      if (m && method === "GET") return page(res, this.landing(m[1]!));
      if (method === "POST" && path === "/hub/v1/register") {
        const body = await readJson(req, 4096);
        return send(res, 201, this.register(body.homeId, body.name, ip));
      }
      m = /^\/hub\/v1\/invites\/([\w-]{10,64})$/.exec(path);
      if (m && method === "GET") return send(res, 200, this.previewInvite(m[1]));
      const home = this.authenticate(req.headers.authorization);
      if (method === "GET" && path === "/hub/v1/me") return send(res, 200, { actorId: ownerOf(home.homeId), name: home.name, friends: this.friendsOf(home.homeId).length });
      if (method === "PUT" && path === "/hub/v1/profile") return send(res, 200, this.setProfile(home, await readJson(req, 4096)));
      if (method === "PUT" && path === "/hub/v1/bots") return send(res, 200, this.setBots(home, (await readJson(req, 100_000)).bots));
      if (method === "POST" && path === "/hub/v1/invites") return send(res, 201, await this.createInvite(home, await readJson(req, 4096)));
      m = /^\/hub\/v1\/invites\/([\w-]{10,64})\/accept$/.exec(path);
      if (m && method === "POST") { await readJson(req, 1024); return send(res, 200, this.acceptInvite(home, m[1], ip)); }
      if (method === "POST" && path === "/hub/v1/founder") { await readJson(req, 1024); return send(res, 200, this.joinFounder(home)); }
      if (method === "GET" && path === "/hub/v1/events") {
        const after = Number(url.searchParams.get("after") ?? -1);
        const wait = Math.min(Math.max(Number(url.searchParams.get("wait") ?? 0), 0), 30) * 1000;
        return send(res, 200, await this.waitForEvents(home, Number.isSafeInteger(after) ? after : -1, wait));
      }
      m = /^\/hub\/v1\/jobs\/([a-f0-9]{64})(?:\/(claim|activity|reply|fail))?$/.exec(path);
      if (m) {
        if (method === "GET" && !m[2]) return send(res, 200, this.jobState(home, m[1]!));
        const body = method === "POST" ? await readJson(req, 40_000_000) : {};
        if (method === "POST" && m[2] === "claim") return send(res, 200, this.claimJob(home, m[1]!));
        if (method === "POST" && m[2] === "activity") return send(res, 200, this.jobActivity(home, m[1]!, body));
        if (method === "POST" && m[2] === "reply") return send(res, 200, this.jobReply(home, m[1]!, body));
        if (method === "POST" && m[2] === "fail") return send(res, 200, this.jobFail(home, m[1]!, body));
      }
      if (path.startsWith("/api/multiplayer/")) return await this.multiplayer(home, req, res, url, method);
      return send(res, 404, { error: "not found" });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      console.warn(`people hub ${method} ${path} failed: ${error instanceof Error ? error.message : "unknown"}`);
      return send(res, 500, { error: "people hub error" });
    }
  }

  private async multiplayer(home: Home, req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const path = url.pathname;
    const actorId = ownerOf(home.homeId);
    if (method === "GET" && path === "/api/multiplayer/me") return send(res, 200, { actorId, homeId: home.homeId, role: "owner", name: home.name });
    if (method === "GET" && path === "/api/multiplayer/contacts") return send(res, 200, { contacts: this.contacts(home) });
    if (method === "POST" && path === "/api/multiplayer/dm") {
      const body = await readJson(req, 1024);
      if (typeof body.targetId !== "string" || !isPerson(body.targetId) || !this.connected(home.homeId, homeOf(body.targetId))) throw new HttpError(400, "choose a connected person");
      const existing = this.rooms.listFor(actorId).find(room => room.kind !== "group" && room.memberIds.length === 2 && room.memberIds.includes(body.targetId as string));
      return send(res, existing ? 200 : 201, { room: existing ?? this.direct(actorId, body.targetId) });
    }
    if (path === "/api/multiplayer/rooms") {
      if (method === "GET") return send(res, 200, { rooms: this.rooms.summariesFor(actorId).map(room => ({ ...room, hub: true,
        ...(room.kind !== "group" ? { name: this.nameOf(room.memberIds.find(id => id !== actorId) ?? actorId) } : {}) })) });
      if (method === "POST") return send(res, 201, { room: this.createRoom(home, await readJson(req, 16_384)) });
    }
    const roomMatch = /^\/api\/multiplayer\/rooms\/([\w-]+)(\/.*)?$/.exec(path);
    if (!roomMatch) return send(res, 404, { error: "not found" });
    const room = this.rooms.roomFor(roomMatch[1]!, actorId);
    if (!room) { req.resume(); return send(res, 404, { error: "conversation unavailable" }); }
    const rest = roomMatch[2] ?? "";
    if (!rest && method === "PATCH") return send(res, 200, { room: this.patchRoom(home, room, await readJson(req, 16_384)) });
    if (!rest && method === "DELETE") {
      const body = await readJson(req, 1024);
      if (room.createdBy !== actorId) throw new HttpError(403, "only the creator can delete this conversation");
      try { this.rooms.deleteRoom(room.id, actorId, body.revision as number); return send(res, 200, { ok: true }); }
      catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "room changed"); }
    }
    if (rest === "/leave" && method === "POST") return send(res, 200, { room: this.leaveRoom(home, room, await readJson(req, 1024)) });
    if (rest === "/preferences") {
      if (method === "GET") return send(res, 200, this.preferences(room, actorId));
      if (method === "PATCH") {
        const body = await readJson(req, 1024);
        if (body.typing !== undefined) this.typing.update(room.id, actorId, body.typing === true);
        if (body.replyBotId != null && !this.roomBots(room, actorId).some(bot => bot.id === body.replyBotId)) throw new HttpError(403, "reply bot is unavailable");
        try { this.rooms.updatePreferences(room.id, actorId, { readSequence: body.readSequence as number | undefined, notifications: body.notifications as never, replyMode: body.replyMode as never, replyBotId: body.replyBotId as never }); }
        catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "invalid preferences"); }
        return send(res, 200, this.preferences(room, actorId));
      }
    }
    const messageMatch = /^\/messages\/([\w-]+)$/.exec(rest);
    if (messageMatch && (method === "PATCH" || method === "DELETE")) {
      const body = method === "PATCH" ? await readJson(req, 100_000) : {};
      try { return send(res, 200, { message: method === "PATCH" && (body.reaction !== undefined || body.pinned !== undefined)
        ? this.rooms.annotateMessage(room.id, actorId, messageMatch[1]!, body) : this.rooms.editMessage(room.id, actorId, messageMatch[1]!, method === "DELETE" ? null : body.text as string, this.now()) }); }
      catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "message unavailable"); }
    }
    if (rest === "/bots" && method === "GET") return send(res, 200, { bots: this.roomBots(room, actorId) });
    if (rest === "/trust" && method === "GET") return send(res, 200, { level: "helper" });
    if (rest === "/search" && method === "GET") {
      try { return send(res, 200, this.rooms.searchFor(room.id, actorId, { query: url.searchParams.get("q") ?? "", kind: (url.searchParams.get("kind") ?? "all") as never,
        author: url.searchParams.get("author") ?? "", before: Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER), limit: Number(url.searchParams.get("limit") ?? 30) })); }
      catch { throw new HttpError(400, "invalid conversation search"); }
    }
    if (rest === "/files" && method === "GET") {
      try { return send(res, 200, this.rooms.filesFor(room.id, actorId, Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER), Number(url.searchParams.get("limit") ?? 30))); }
      catch { throw new HttpError(400, "invalid file cursor"); }
    }
    if (rest === "/requests" && method === "GET") return send(res, 200, this.requests(room, url));
    const cancel = /^\/requests\/([\w-]+)\/cancel$/.exec(rest);
    if (cancel && method === "POST") return send(res, 200, this.cancelRequest(home, room, cancel[1]!));
    if (rest === "/attachments" && method === "POST") {
      const body = await readJson(req, 15_000_000);
      return send(res, 201, { attachment: this.saveAttachment(room.id, actorId, body.name, body.mime, body.data) });
    }
    const file = /^\/attachments\/([\w-]+)$/.exec(rest);
    if (file && method === "GET") {
      const item = this.attachment(room.id, file[1]!);
      return item ? send(res, 200, item) : send(res, 404, { error: "attachment unavailable" });
    }
    if (rest === "/messages" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 100);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "invalid room cursor");
      const typing = this.typing.list(room.id, actorId, room.memberIds);
      const beforeValue = url.searchParams.get("before");
      if (beforeValue !== null) {
        const before = Number(beforeValue);
        if (!Number.isSafeInteger(before) || before < 1) throw new HttpError(400, "invalid history cursor");
        const messages = this.rooms.allMessages(room.id).filter(message => message.sequence < before).slice(-limit);
        return send(res, 200, { messages, typing, hasMore: (messages[0]?.sequence ?? 1) > 1, version: room.messageVersion ?? 0 });
      }
      if (url.searchParams.get("latest") === "1") {
        const messages = this.rooms.latestFor(room.id, actorId, limit);
        return send(res, 200, { messages, typing, hasMore: (messages[0]?.sequence ?? 1) > 1, version: room.messageVersion ?? 0 });
      }
      const version = Number(url.searchParams.get("version") ?? 0);
      if (!Number.isSafeInteger(version) || version < 0) throw new HttpError(400, "invalid change cursor");
      return send(res, 200, { typing, messages: this.rooms.messagesAfter(room.id, actorId, after, limit), ...this.rooms.changesAfter(room.id, actorId, version) });
    }
    if (rest === "/messages" && method === "POST") {
      const result = this.postMessage(home, room, await readJson(req, 100_000));
      return send(res, result.created ? 201 : 200, result);
    }
    return send(res, 404, { error: "not found" });
  }

  private landing(token: string): string {
    let from: string | null = null;
    try { from = this.previewInvite(token).from; } catch { /* expired */ }
    const link = `${this.opts.publicOrigin}/i/${token}`;
    const body = from
      ? `<h1>${escapeHtml(from)} invited you to BOS Bot</h1>
<p>Chat with ${escapeHtml(from)}, start group chats, and bring your AI bots into the conversation.</p>
<a class="btn" href="https://app.bosbot.my/?invite=${encodeURIComponent(token)}">Try it free in your browser</a>
<a class="btn alt" href="https://bosbot.my/download/?invite=${encodeURIComponent(token)}">Download for Mac or Windows</a>
<p class="small">Already have BOS Bot on this computer, or just installed it?</p>
<a class="btn alt" href="bosbot://invite?token=${encodeURIComponent(token)}">Open in BOS Bot</a>
<p class="small">Or click <b>Add a friend</b> in BOS Bot's chat list and paste this link:</p>
<div class="copy"><input readonly value="${link}" onclick="this.select()"><button onclick="navigator.clipboard.writeText('${link}');this.textContent='Copied'">Copy</button></div>`
      : `<h1>This invite has expired</h1><p>Ask your friend to send you a new link from BOS Bot.</p><a class="btn" href="https://bosbot.my/">About BOS Bot</a>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${from ? `${escapeHtml(from)} invited you to BOS Bot` : "BOS Bot invite"}</title><meta name="robots" content="noindex">
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;background:#f6f6f4;color:#111;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;border-radius:16px;padding:32px;max-width:440px;margin:16px;box-shadow:0 1px 3px #0001}h1{font-size:22px;margin:0 0 8px}
.btn{display:block;text-align:center;background:#111;color:#fff;padding:12px;border-radius:10px;text-decoration:none;margin:12px 0}.btn.alt{background:#eee;color:#111}
.small{color:#555;font-size:14px;margin-top:20px}.copy{display:flex;gap:8px}.copy input{flex:1;padding:8px;border:1px solid #ddd;border-radius:8px;font-size:13px}
.copy button{padding:8px 12px;border:0;border-radius:8px;background:#111;color:#fff}</style></head><body><main>${body}</main></body></html>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function page(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" });
  res.end(html);
}

async function readJson(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "request too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { throw new HttpError(400, "invalid json"); }
}

export function startHub(opts: HubOptions & { port: number; host?: string }): { hub: PeopleHub; server: Server } {
  const hub = new PeopleHub(opts);
  const server = createServer((req, res) => { void hub.handle(req, res); });
  server.requestTimeout = 60_000;
  server.listen(opts.port, opts.host ?? "127.0.0.1");
  return { hub, server };
}
