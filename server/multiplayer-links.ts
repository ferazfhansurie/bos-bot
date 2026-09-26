import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { contactId, parseContactId } from "../shared/multiplayer.ts";

interface RemoteBot { id: string; name: string; title: string; color?: string; mascotBody?: string | null; avatarUrl?: string | null; avatarCrop?: string; hidden?: boolean }
interface RemoteLink {
  homeId: string;
  origin: string;
  name: string;
  token: string;
  bots: RemoteBot[];
  ownerName?: string;
  ownerAvatar?: string | null;
  proxyGroups: Record<string, string>;
}
interface Snapshot { version: 1; links: RemoteLink[] }
interface PrimaryRoomHome { homeId: string; actorId: string }

const parseBot = (value: unknown): RemoteBot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const bot = value as Record<string, unknown>;
  if (typeof bot.id !== "string" || typeof bot.name !== "string" || typeof bot.title !== "string") return null;
  return { id: bot.id, name: bot.name, title: bot.title,
    color: typeof bot.color === "string" ? bot.color : undefined,
    mascotBody: typeof bot.mascotBody === "string" ? bot.mascotBody : null,
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

  constructor(file: string, homeId: string, fetcher: typeof fetch = fetch) {
    this.file = file;
    this.homeId = homeId;
    this.fetcher = fetcher;
    if (!existsSync(file)) return;
    let snapshot: Snapshot;
    try { snapshot = JSON.parse(readFileSync(file, "utf8")) as Snapshot; }
    catch { throw new Error("could not read multiplayer links"); }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.links)) throw new Error("invalid multiplayer links");
    for (const link of snapshot.links) {
      this.checkLink(link);
      if (this.links.has(link.homeId)) throw new Error("duplicate multiplayer link");
      this.links.set(link.homeId, link);
    }
    const primary = (snapshot as Snapshot & { primary?: PrimaryRoomHome }).primary;
    if (primary) {
      if (typeof primary.homeId !== "string" || !this.links.has(primary.homeId) ||
          typeof primary.actorId !== "string" || parseContactId(primary.actorId)?.kind !== "person") {
        throw new Error("invalid primary shared chat home");
      }
      this.primary = primary;
    }
  }

  private checkLink(link: RemoteLink): void {
    const origin = new URL(link.origin);
    if (origin.protocol !== "https:" || !origin.hostname.endsWith(".ts.net") || origin.pathname !== "/" ||
        origin.search || origin.hash || origin.username || origin.password ||
        !/^[\w-]{1,128}$/.test(link.homeId) || link.homeId === this.homeId ||
        !link.token.startsWith("omb_sess_") || !Array.isArray(link.bots) || !link.proxyGroups || typeof link.proxyGroups !== "object") {
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

  async forwardShared(path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const link = this.primary && this.links.get(this.primary.homeId);
    if (!link) throw new Error("shared chat home is unavailable");
    if (!/^\/api\/multiplayer\/(?:me|contacts|dm|push-token|rooms(?:\/[\w-]+\/(?:messages|attachments(?:\/[\w-]+)?))?)?(?:\?[\w=&-]+)?$/.test(path)) {
      throw new Error("invalid shared chat route");
    }
    const url = new URL(path, link.origin);
    const response = await this.fetcher(url, {
      method, redirect: "error", signal: AbortSignal.timeout(25_000),
      headers: { authorization: `Bearer ${link.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  async addFromPairingUrl(pairingUrl: string): Promise<{ homeId: string; name: string; bots: RemoteBot[] }> {
    const url = new URL(pairingUrl);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || url.pathname !== "/pair" || url.username || url.password) {
      throw new Error("use a private HTTPS pairing link from the other Mac");
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
    if (this.links.has(descriptor.environmentId)) throw new Error("workspace is already linked");
    const paired = await this.fetcher(new URL("/api/auth/pair", origin), {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(20_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, label: "BOS multiplayer bridge" }),
    });
    if (!paired.ok) throw new Error(`other workspace refused pairing (${paired.status})`);
    const redeemed = await paired.json() as Record<string, any>;
    const scopes = redeemed.session?.scopes;
    if (!Array.isArray(scopes) || !scopes.includes("client") || scopes.includes("admin") || typeof redeemed.token !== "string") {
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
    if (url.protocol !== "https:" || !url.hostname.endsWith(".ts.net") || url.pathname !== "/" || url.search || url.hash || url.username || url.password || !/^omb_sess_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error("invalid private workspace link");
    }
    const descriptorResponse = knownDescriptor ? null : await this.fetcher(new URL("/.well-known/openmausbot/environment", origin), {
      redirect: "error", signal: AbortSignal.timeout(20_000),
    });
    if (descriptorResponse && !descriptorResponse.ok) throw new Error("other workspace did not answer");
    const descriptor = knownDescriptor ?? await descriptorResponse!.json() as Record<string, unknown>;
    if (typeof descriptor.environmentId !== "string" || !/^[\w-]{1,128}$/.test(descriptor.environmentId) || descriptor.environmentId === this.homeId) {
      throw new Error("other workspace identity is invalid");
    }
    if (this.links.has(descriptor.environmentId)) throw new Error("workspace is already linked");
    const link: RemoteLink = { homeId: descriptor.environmentId, origin, name: String(descriptor.label ?? "Other Mac").slice(0, 80), token, bots: [], proxyGroups: {} };
    this.checkLink(link);
    let bots: RemoteBot[];
    try { bots = await this.refreshBotsFor(link); }
    catch (error) {
      await this.fetcher(new URL("/api/auth/logout", origin), { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch(() => {});
      throw error;
    }
    this.links.set(link.homeId, link);
    this.persist();
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

  contacts(): Array<{ id: string; name: string; kind: "bot"; homeId: string; title: string; color?: string; mascotBody?: string | null; avatarUrl?: string | null; avatarCrop?: string }> {
    return [...this.links.values()].flatMap(link => link.bots.map(bot => ({
      id: contactId({ homeId: link.homeId, kind: "bot", localId: bot.id }),
      name: bot.name, kind: "bot" as const, homeId: link.homeId, title: bot.title,
      color: bot.color, mascotBody: bot.mascotBody, avatarUrl: bot.avatarUrl, avatarCrop: bot.avatarCrop,
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
}
