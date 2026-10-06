import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { quarantineSaved } from "./quarantine-saved.ts";
import { contactId, parseContactId } from "../shared/multiplayer.ts";

interface RemoteBot { id: string; name: string; title: string; color?: string; mascotBody?: string | null; mascotEyes?: string | null; avatarUrl?: string | null; avatarCrop?: string; hidden?: boolean }
interface RemoteLink {
  homeId: string;
  origin: string;
  name: string;
  token: string;
  bots: RemoteBot[];
  ownerName?: string;
  ownerAvatar?: string | null;
  proxyGroups: Record<string, string>;
  /** Rooms on this canonical home that this guest has joined, as last
   * reported by the home's own membership-checked GET /api/groups. */
  joinedGroups?: JoinedGroup[];
}
interface JoinedGroup { id: string; name: string; threadIds: string[]; memberIds?: string[]; memberBots?: RemoteBot[]; avatarUrl?: string | null }
/** A joined room exactly as the canonical home serves it, plus the home. */
export type RemoteGroupView = Record<string, unknown> & { id: string; name: string; threadId: string; home: { id: string; name: string; available: boolean } };
interface Snapshot { version: 1; links: RemoteLink[] }
interface PrimaryRoomHome { homeId: string; actorId: string }

const ROOM_ID = /^[\w-]{1,128}$/;
const AVATAR_NAME = /^[\w-]{1,128}\.(?:png|jpg|jpeg|gif|webp)$/;
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
/** Canonical-home avatar paths mean nothing to this home's own server; point
 * them at the guest-side relay for that room instead. */
export function relayAvatars<T extends Record<string, unknown>>(group: T, groupId: string): T {
  const relay = (url: unknown) => typeof url === "string" && url.startsWith("/api/attachments/") && AVATAR_NAME.test(url.slice(17))
    ? `/api/groups/${groupId}/avatars/${url.slice(17)}` : typeof url === "string" ? null : url;
  const bots = Array.isArray(group.memberBots) ? group.memberBots.map(bot => bot && typeof bot === "object" && "avatarUrl" in bot ? { ...bot, avatarUrl: relay(bot.avatarUrl) } : bot) : group.memberBots;
  return { ...group, ...("avatarUrl" in group ? { avatarUrl: relay(group.avatarUrl) } : {}), ...(Array.isArray(group.memberBots) ? { memberBots: bots } : {}) };
}
/** The only canonical-home room routes a guest home relays. Each route is
 * membership-checked again by the canonical home; nothing else is reachable. */
const GROUP_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: "GET", path: /^\/api\/groups(?:\/[\w-]+(?:\/tasks)?)?(?:\?[\w%+.,:~=&-]+)?$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/messages$/ },
  { method: "POST", path: /^\/api\/groups\/[\w-]+\/people$/ },
  { method: "DELETE", path: /^\/api\/groups\/[\w-]+\/people\/[\w%.:-]{1,300}$/ },
  { method: "GET", path: /^\/api\/threads\/[\w-]+\/messages(?:\?[\w%+.,:~=&-]+)?$/ },
];
export const remoteGroupRouteAllowed = (method: string, path: string): boolean =>
  GROUP_ROUTES.some(route => route.method === method && route.path.test(path));

const parseJoinedGroup = (value: unknown): JoinedGroup | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const group = value as Record<string, unknown>;
  if (typeof group.id !== "string" || !ROOM_ID.test(group.id) || typeof group.name !== "string" || typeof group.threadId !== "string" || !ROOM_ID.test(group.threadId)) return null;
  const tasks = Array.isArray(group.tasks) ? group.tasks : [];
  const threadIds = [group.threadId, ...tasks.map(task => (task as { threadId?: unknown })?.threadId)]
    .filter((id): id is string => typeof id === "string" && ROOM_ID.test(id));
  const memberIds = Array.isArray(group.memberIds) ? group.memberIds.filter((id): id is string => typeof id === "string" && ROOM_ID.test(id)).slice(0, 500) : undefined;
  const memberBots = Array.isArray(group.memberBots) ? group.memberBots.map(parseBot).filter((bot): bot is RemoteBot => !!bot && !bot.hidden && !!memberIds?.includes(bot.id)).slice(0, 500).map(({ hidden: _hidden, ...bot }) => bot) : undefined;
  return { id: group.id, name: group.name.slice(0, 200), threadIds: [...new Set(threadIds)].slice(0, 500),
    ...(memberIds ? { memberIds } : {}), ...(memberBots ? { memberBots } : {}),
    ...(typeof group.avatarUrl === "string" || group.avatarUrl === null ? { avatarUrl: group.avatarUrl } : {}) };
};

const parseBot = (value: unknown): RemoteBot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bot = value as Record<string, unknown>;
  if (typeof bot.id !== "string" || typeof bot.name !== "string" || typeof bot.title !== "string") return null;
  return { id: bot.id, name: bot.name, title: bot.title,
    color: typeof bot.color === "string" ? bot.color : undefined,
    mascotBody: typeof bot.mascotBody === "string" ? bot.mascotBody : null,
    mascotEyes: typeof bot.mascotEyes === "string" ? bot.mascotEyes : null,
    avatarUrl: typeof bot.avatarUrl === "string" ? bot.avatarUrl : null,
    avatarCrop: typeof bot.avatarCrop === "string" ? bot.avatarCrop : undefined,
    hidden: bot.hidden === true };
};

/** A host-to-host chat-only session. It cannot access remote admin routes. */
export class MultiplayerLinks {
  private readonly links = new Map<string, RemoteLink>();
  private readonly file: string;
  private readonly homeId: string;
  private readonly fetcher: typeof fetch;
  private primary: PrimaryRoomHome | null = null;
  /** Last full room views per home, from the canonical home. Memory only. */
  private readonly groupViews = new Map<string, Array<Record<string, unknown>>>();

  constructor(file: string, homeId: string, fetcher: typeof fetch = fetch) {
    this.file = file;
    this.homeId = homeId;
    this.fetcher = fetcher;
    if (!existsSync(file)) return;
    let snapshot: Snapshot;
    try { snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot; }
    catch {
      quarantineSaved(file, { version: 1, links: [], primary: null });
      return;
    }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.links)) throw new Error("invalid multiplayer links");
    let invalid = false;
    for (const link of snapshot.links) {
      try {
        this.checkLink(link);
        if (this.links.has(link.homeId)) throw new Error("duplicate multiplayer link");
        if (link.joinedGroups) link.joinedGroups = link.joinedGroups.map(group => parseJoinedGroup({ ...group, threadId: group.threadIds[0], tasks: group.threadIds.slice(1).map(threadId => ({ threadId })) })!);
        this.links.set(link.homeId, link);
      } catch { invalid = true; }
    }
    const primary = (snapshot as Snapshot & { primary?: PrimaryRoomHome }).primary;
    if (primary) {
      if (typeof primary.homeId !== "string" || !this.links.has(primary.homeId) ||
          typeof primary.actorId !== "string" || parseContactId(primary.actorId)?.kind !== "person") {
        invalid = true;
      } else {
        this.primary = primary;
      }
    }
    if (invalid) quarantineSaved(file, { version: 1, links: [...this.links.values()], primary: this.primary });
  }

  private checkLink(link: RemoteLink): void {
    const origin = new URL(link.origin);
    if (origin.protocol !== "https:" || origin.pathname !== "/" ||
        origin.search || origin.hash || origin.username || origin.password ||
        !/^[\w-]{1,128}$/.test(link.homeId) || link.homeId === this.homeId ||
        !link.token.startsWith("omb_sess_") || !Array.isArray(link.bots) || !link.proxyGroups || typeof link.proxyGroups !== "object" ||
        link.joinedGroups !== undefined && (!Array.isArray(link.joinedGroups) || link.joinedGroups.some(group => !group || typeof group.name !== "string" ||
          !ROOM_ID.test(group.id) || !Array.isArray(group.threadIds) || !group.threadIds.length || group.threadIds.some(id => !ROOM_ID.test(id))))) {
      throw new Error("invalid multiplayer link");
    }
  }

  private async request(link: RemoteLink, path: string, init: RequestInit = {}): Promise<any> {
    const url = new URL(path, link.origin);
    if (url.origin !== link.origin) throw new Error("invalid remote route");
    const response = await this.fetcher(url, {
      ...init, redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${link.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    });
    const result = await response.json() as Record<string, any>;
    if (!response.ok) throw new Error(`remote workspace returned ${response.status}: ${String(result?.error ?? "request failed").slice(0, 160)}`);
    return result;
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileAtomic(this.file, JSON.stringify({ version: 1, links: [...this.links.values()], primary: this.primary }), { mode: 0o600 });
  }

  primaryActorId(): string | null { return this.primary?.actorId ?? null; }

  async setPrimary(homeId: string): Promise<PrimaryRoomHome> {
    const link = this.links.get(homeId);
    if (!link) throw new Error("workspace link is unavailable");
    const me = await this.request(link, "/api/multiplayer/me");
    if (typeof me.actorId !== "string" || parseContactId(me.actorId)?.kind !== "person") {
      throw new Error("bridge session must be bound to a person on the shared chat home");
    }
    this.primary = { homeId, actorId: me.actorId };
    this.persist();
    return this.primary;
  }

  /** Explicit server selection never rewrites this home's identity or primary. */
  async forwardServer(homeId: string, path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const link = this.links.get(homeId);
    if (!link) throw new Error("server is not joined");
    return this.forwardTo(link, path, method, body);
  }

  async forwardShared(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const link = this.primary && this.links.get(this.primary.homeId);
    if (!link) throw new Error("shared chat home is unavailable");
    return this.forwardTo(link, path, method, body);
  }

  private async forwardTo(link: RemoteLink, path: string, method: string, body?: unknown, routes?: typeof GROUP_ROUTES): Promise<{ status: number; body: unknown }> {
    if (routes ? !routes.some(route => route.method === method && route.path.test(path))
      : !/^\/api\/multiplayer\/(?:me|contacts|members|invites|dm|push-token|rooms(?:\/[\w-]+(?:\/(?:messages(?:\/[\w-]+)?|leave|bots|bot-grants|members|preferences|files|search|requests(?:\/[\w-]+\/cancel)?|attachments(?:\/[\w-]+)?))?)?)?(?:\?[\w%+.,:~=&-]+)?$/.test(path)) {
      throw new Error(routes ? "invalid joined room route" : "invalid shared chat route");
    }
    const url = new URL(path, link.origin);
    if (routes && (url.origin !== link.origin || url.pathname + url.search !== path)) throw new Error("invalid joined room route");
    const response = await this.fetcher(url, {
      method, redirect: "error", signal: AbortSignal.timeout(25_000),
      headers: { authorization: `Bearer ${link.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  /** Seam for room-people: joined remote room id -> canonical home id. */
  joinedGroupHomes(): Map<string, string> {
    const homes = new Map<string, string>();
    for (const link of this.links.values()) for (const group of link.joinedGroups ?? []) if (!homes.has(group.id)) homes.set(group.id, link.homeId);
    return homes;
  }

  homeLabel(homeId: string): string {
    const link = this.links.get(homeId);
    return link?.ownerName ?? link?.name ?? "Other home";
  }

  /** Canonical home of a thread inside a joined remote room. */
  joinedThreadHome(threadId: string): string | null {
    for (const link of this.links.values()) if (link.joinedGroups?.some(group => group.threadIds.includes(threadId))) return link.homeId;
    return null;
  }

  /** Ask one canonical home which rooms this guest belongs to and record the
   * answer in the link. A home without room people (or that refuses) leaves
   * the previous record untouched; a 200 list is authoritative. */
  async refreshJoinedGroups(homeId: string): Promise<boolean> {
    const link = this.links.get(homeId);
    if (!link) return false;
    const answer = await this.forwardTo(link, "/api/groups", "GET", undefined, GROUP_ROUTES);
    const groups = (answer.body as { groups?: unknown } | null)?.groups;
    if (answer.status !== 200 || !Array.isArray(groups)) return false;
    const views = groups.slice(0, 500).filter(group => parseJoinedGroup(group)) as Array<Record<string, unknown>>;
    const joined = views.map(group => parseJoinedGroup(group)!);
    if (this.links.get(homeId) !== link) return false;
    this.groupViews.set(homeId, views);
    if (JSON.stringify(joined) !== JSON.stringify(link.joinedGroups ?? [])) {
      const previous = link.joinedGroups;
      link.joinedGroups = joined;
      try { this.persist(); }
      catch (error) { link.joinedGroups = previous; throw error; }
    }
    return true;
  }

  /** Joined remote rooms in the local Group shape plus `home`. Each home gets
   * `waitMs` to answer; an unreachable home lists its last known rooms. */
  async remoteGroups(waitMs = 2_500): Promise<RemoteGroupView[]> {
    const links = [...this.links.values()];
    const fresh = await Promise.all(links.map(link => Promise.race([
      this.refreshJoinedGroups(link.homeId).catch(() => false),
      new Promise<boolean>(resolve => setTimeout(resolve, waitMs, false).unref?.()),
    ])));
    return links.flatMap((link, index) => {
      const home = { id: link.homeId, name: this.homeLabel(link.homeId), available: fresh[index] };
      const views = this.groupViews.get(link.homeId);
      const joined = new Set((link.joinedGroups ?? []).map(group => group.id));
      if (views) return views.filter(view => joined.has(view.id as string)).map(view => ({ ...relayAvatars(view, view.id as string), home }) as RemoteGroupView);
      return (link.joinedGroups ?? []).map(group => relayAvatars({
        id: group.id, name: group.name, threadId: group.threadIds[0], memberIds: group.memberIds ?? [], memberBots: group.memberBots ?? [], avatarUrl: group.avatarUrl, defaultResponder: { kind: "mentions" },
        bulletin: "", unread: false, createdAt: 0, messages: [], home,
      }, group.id) as RemoteGroupView);
    });
  }

  /** Relay one allowlisted room route to the room's canonical home with only
   * the link's own chat-only token. */
  async forwardGroup(homeId: string, path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const link = this.links.get(homeId);
    if (!link) throw new Error("joined room home is unavailable");
    return this.forwardTo(link, path, method, body, GROUP_ROUTES);
  }

  /** One avatar image of a joined room, fetched from its canonical home with
   * the link's chat-only token. Only names the home itself listed as the
   * room's or a member bot's avatar are fetched; anything else is refused. */
  async groupAvatar(homeId: string, groupId: string, name: string): Promise<{ mime: string; bytes: Buffer } | null> {
    const link = this.links.get(homeId);
    const group = link?.joinedGroups?.find(item => item.id === groupId);
    if (!link || !group || !AVATAR_NAME.test(name)) return null;
    const path = `/api/attachments/${name}`;
    if (group.avatarUrl !== path && !group.memberBots?.some(bot => bot.avatarUrl === path)) return null;
    const response = await this.fetcher(new URL(path, link.origin), {
      redirect: "error", signal: AbortSignal.timeout(25_000), headers: { authorization: `Bearer ${link.token}` },
    });
    const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!response.ok || !/^image\/(?:png|jpeg|gif|webp)$/.test(mime)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    return bytes.byteLength <= MAX_AVATAR_BYTES ? { mime, bytes } : null;
  }

  /** The canonical home's person-scoped event stream for this guest. */
  async openGroupEvents(homeId: string, signal: AbortSignal): Promise<Response> {
    const link = this.links.get(homeId);
    if (!link) throw new Error("joined room home is unavailable");
    return this.fetcher(new URL("/api/events", link.origin), {
      redirect: "error", signal, headers: { authorization: `Bearer ${link.token}`, accept: "text/event-stream" },
    });
  }

  async addFromPairingUrl(pairingUrl: string): Promise<{ homeId: string; name: string; bots: RemoteBot[] }> {
    const url = new URL(pairingUrl);
    if (url.protocol !== "https:" || url.pathname !== "/pair" || url.username || url.password) {
      throw new Error("use an HTTPS pairing link from the other server");
    }
    const code = new URLSearchParams(url.hash.slice(1)).get("code");
    if (!code || !/^[A-Z0-9-]{12,20}$/i.test(code)) throw new Error("pairing link has no valid code");
    const origin = url.origin;
    const descriptorResponse = await this.fetcher(new URL("/.well-known/openmausbot/environment", origin), {
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (!descriptorResponse.ok) throw new Error("other workspace did not answer");
    const descriptor = await descriptorResponse.json() as Record<string, unknown>;
    if (typeof descriptor.environmentId !== "string" || !/^[\w-]{1,128}$/.test(descriptor.environmentId) || descriptor.environmentId === this.homeId) {
      throw new Error("other workspace identity is invalid");
    }
    const paired = await this.fetcher(new URL("/api/auth/pair", origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: "BOS multiplayer bridge" }),
    });
    if (!paired.ok) throw new Error(`other workspace refused pairing (${paired.status})`);
    const redeemed = await paired.json() as Record<string, any>;
    const scopes = redeemed.session?.scopes;
    if (!Array.isArray(scopes) || !scopes.includes("peer") || scopes.includes("admin") || typeof redeemed.token !== "string") {
      if (typeof redeemed.token === "string") {
        await this.fetcher(new URL("/api/auth/logout", origin), { method: "POST", headers: { authorization: `Bearer ${redeemed.token}` } }).catch(() => {});
      }
      throw new Error("pairing link must grant chat-only access");
    }
    return this.addVerified(origin, redeemed.token, descriptor);
  }

  /** Install a client-scoped link created by the other home's owner during a team join. */
  async addVerified(origin: string, token: string, knownDescriptor?: Record<string, unknown>): Promise<{ homeId: string; name: string; bots: RemoteBot[] }> {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !/^omb_sess_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("invalid HTTPS workspace link");
    }
    const descriptorResponse = knownDescriptor ? null : await this.fetcher(new URL("/.well-known/openmausbot/environment", origin), {
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (descriptorResponse && !descriptorResponse.ok) throw new Error("other workspace did not answer");
    const descriptor = knownDescriptor ?? await descriptorResponse!.json() as Record<string, unknown>;
    if (descriptor.multiplayerProtocol !== 1) throw new Error(`update BOS on ${String(descriptor.label ?? "the other Mac").slice(0, 80)} before linking shared chat`);
    if (typeof descriptor.environmentId !== "string" || !/^[\w-]{1,128}$/.test(descriptor.environmentId) || descriptor.environmentId === this.homeId) {
      throw new Error("other workspace identity is invalid");
    }
    const previous = this.links.get(descriptor.environmentId);
    const link: RemoteLink = { homeId: descriptor.environmentId, origin, name: String(descriptor.label ?? previous?.name ?? "Other Mac").slice(0, 80), token,
      bots: [], proxyGroups: previous?.proxyGroups ?? {}, ...(previous?.joinedGroups ? { joinedGroups: previous.joinedGroups } : {}) };
    this.checkLink(link);
    let bots: RemoteBot[];
    try { bots = await this.refreshBotsFor(link); }
    catch (error) {
      await this.fetcher(new URL("/api/auth/logout", origin), { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
      throw error;
    }
    this.links.set(link.homeId, link);
    this.persist();
    if (previous?.token && previous.token !== token) {
      // Once the replacement is durable, retire the superseded peer session.
      await this.fetcher(new URL("/api/auth/logout", previous.origin), {
        method: "POST", headers: { authorization: `Bearer ${previous.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
      }).catch(() => {});
    }
    return { homeId: link.homeId, name: link.name, bots };
  }

  private async refreshBotsFor(link: RemoteLink): Promise<RemoteBot[]> {
    const [result, home] = await Promise.all([
      this.request(link, "/api/bots?messages=0"),
      this.request(link, "/api/multiplayer/home"),
    ]);
    link.bots = Array.isArray(result.bots) ? result.bots.map(parseBot).filter((bot: RemoteBot | null): bot is RemoteBot => Boolean(bot && !bot.hidden)) : [];
    link.ownerName = typeof home.name === "string" ? home.name.slice(0, 80) : undefined;
    link.ownerAvatar = typeof home.avatar === "string" && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]{1,350000}$/.test(home.avatar) ? home.avatar : null;
    return link.bots;
  }

  async refreshBots(homeId: string): Promise<RemoteBot[]> {
    const link = this.links.get(homeId);
    if (!link) throw new Error("remote workspace is not linked");
    const bots = await this.refreshBotsFor(link);
    this.persist();
    return bots;
  }

  async refreshAllBots(): Promise<void> {
    await Promise.allSettled([...this.links.keys()].map(homeId => this.refreshBots(homeId)));
  }

  contacts(): Array<{ id: string; name: string; kind: "bot"; homeId: string; title: string; color?: string; mascotBody?: string | null; mascotEyes?: string | null; avatarUrl?: string | null; avatarCrop?: string }> {
    return [...this.links.values()].flatMap(link => link.bots.map(bot => ({
      id: contactId({ homeId: link.homeId, kind: "bot", localId: bot.id }),
      name: bot.name, kind: "bot" as const, homeId: link.homeId, title: bot.title,
      color: bot.color, mascotBody: bot.mascotBody, mascotEyes: bot.mascotEyes, avatarUrl: bot.avatarUrl, avatarCrop: bot.avatarCrop,
    })));
  }

  avatarForPerson(name: string): string | null {
    const matches = [...this.links.values()].filter(link => link.ownerName?.trim().toLowerCase() === name.trim().toLowerCase());
    return matches.length === 1 ? matches[0].ownerAvatar ?? null : null;
  }

  hasBot(homeId: string, botId: string): boolean {
    return this.links.get(homeId)?.bots.some(bot => bot.id === botId) ?? false;
  }

  /** Link credentials for the remote bot bridge. Server-side only: the
   * token is never part of any client response. */
  bridgeLinks(): Array<{ homeId: string; origin: string; token: string; name: string; ownerName: string | null }> {
    return [...this.links.values()].map(link => ({
      homeId: link.homeId, origin: link.origin, token: link.token, name: link.name, ownerName: link.ownerName ?? null,
    }));
  }

  replaceToken(homeId: string, token: string): void {
    if (!/^omb_sess_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("invalid peer session token");
    const link = this.links.get(homeId);
    if (!link) throw new Error("peer link is unavailable");
    const previous = link.token;
    link.token = token;
    try { this.persist(); }
    catch (error) { link.token = previous; throw error; }
  }

  async remove(homeId: string): Promise<boolean> {
    const previous = this.links.get(homeId);
    if (!previous) return false;
    const primary = this.primary;
    this.links.delete(homeId);
    if (this.primary?.homeId === homeId) this.primary = null;
    try { this.persist(); }
    catch (error) { this.links.set(homeId, previous); this.primary = primary; throw error; }
    this.groupViews.delete(homeId);
    await this.fetcher(new URL("/api/auth/logout", previous.origin), {
      method: "POST", headers: { authorization: `Bearer ${previous.token}` }, redirect: "error", signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
    return true;
  }

  async reannounce(homeId: string, origin: string): Promise<boolean> {
    const link = this.links.get(homeId);
    if (!link) return false;
    const next = new URL(origin);
    const previous = new URL(link.origin);
    if (next.protocol !== "https:" || !next.hostname.endsWith(".ts.net") || next.pathname !== "/" || next.search || next.hash ||
        next.username || next.password || next.hostname.split(".").slice(1).join(".") !== previous.hostname.split(".").slice(1).join(".")) {
      throw new Error("new address must be on the same private tailnet");
    }
    if (next.origin === previous.origin) return true;
    const descriptor = await this.fetcher(new URL("/.well-known/openmausbot/environment", next), {
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    const identity = descriptor.ok ? await descriptor.json() as { environmentId?: string; multiplayerProtocol?: number } : null;
    if (identity?.environmentId !== homeId || identity.multiplayerProtocol !== 1) {
      throw new Error("new address did not verify the linked Mac identity");
    }
    const probe = await this.fetcher(new URL("/api/multiplayer/home", next), {
      headers: { authorization: `Bearer ${link.token}` }, redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!probe.ok || (await probe.json() as { homeId?: string }).homeId !== homeId) throw new Error("new address did not accept the existing peer session");
    const oldOrigin = link.origin;
    link.origin = next.origin;
    try { this.persist(); }
    catch (error) { link.origin = oldOrigin; throw error; }
    return true;
  }
}
