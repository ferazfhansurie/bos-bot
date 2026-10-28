// HTTP for installing mini apps from a link. Owner only. Installing is two steps
// so the owner sees exactly what the app asks for first: preview fetches and
// checks the bundle and holds it under a token; install takes the token, so
// what gets installed is byte for byte what was previewed.
import { randomBytes } from "node:crypto";

import type { AppHttp } from "./app-routes.ts";
import type { AppStore } from "./apps.ts";
import type { ResolvedMiniApp } from "./mini-app-fetch.ts";

const PREVIEW_MS = 10 * 60_000;
const PREVIEWS = 20;

/** Previews waiting for an ok. One per server. */
export class MiniAppPending {
  private previews = new Map<string, { bundle: ResolvedMiniApp; expires: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }

  hold(bundle: ResolvedMiniApp): string {
    const now = this.now();
    for (const [token, held] of this.previews) if (held.expires <= now) this.previews.delete(token);
    while (this.previews.size >= PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
    const token = randomBytes(18).toString("base64url");
    this.previews.set(token, { bundle, expires: now + PREVIEW_MS });
    return token;
  }

  get(token: string): ResolvedMiniApp | null {
    const held = this.previews.get(token);
    if (!held || held.expires <= this.now()) return null;
    return held.bundle;
  }

  drop(token: string) { this.previews.delete(token); }
}

export interface MiniAppRouteDeps extends AppHttp {
  apps: AppStore;
  pending: MiniAppPending;
  /** The owner's display name, or null when this request isn't the owner. Checked again after every body read. */
  owner: () => string | null;
  botIds: () => string[];
  botName: (botId: string) => string | null;
  /** Fetch and check an install link (server/mini-app-fetch.ts). */
  resolveLink: (url: string) => Promise<ResolvedMiniApp>;
  /** An app that ships with bos ("crm"); null when unknown. */
  builtin: (id: string) => Promise<ResolvedMiniApp | null>;
}

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function handleMiniAppRoute(method: string, path: string, deps: MiniAppRouteDeps): Promise<boolean> {
  const m = path.match(/^\/api\/apps\/install(?:\/(preview))?$/);
  if (!m) return false;
  const preview = m[1];
  try {
    const owner = () => {
      const name = deps.owner();
      if (!name) throw fail(403, "only the owner can install apps");
      return name;
    };
    owner();
    if (method !== "POST") { deps.json(405, { error: "method not allowed" }); return true; }
    const body = async (limit: number) => {
      const value = await deps.readBody(limit);
      owner();
      return plain(value) ? value : {};
    };

    if (preview) {
      const input = await body(4_000);
      let bundle: ResolvedMiniApp | null;
      if (typeof input.builtin === "string") {
        bundle = await deps.builtin(input.builtin);
        if (!bundle) throw fail(404, "bos doesn't ship an app called that");
      } else if (typeof input.url === "string" && input.url.trim()) {
        try { bundle = await deps.resolveLink(input.url); }
        catch (error) { throw fail((error as { status?: number }).status ?? 422, (error as Error).message); }
      } else throw fail(400, "paste an app link");
      owner();
      const existing: Record<string, { appId: string; version: string }> = {};
      for (const botId of deps.botIds()) {
        const app = deps.apps.installedFor(botId, bundle.manifest.id, bundle.source);
        if (app?.installed) existing[botId] = { appId: app.id, version: app.installed.version };
      }
      const source = bundle.source.startsWith("builtin:") ? null : new URL(bundle.source);
      deps.json(200, {
        token: deps.pending.hold(bundle),
        preview: { manifest: bundle.manifest, source: bundle.source, host: source?.host ?? "bos", builtin: !source, bytes: bundle.bytes, existing },
      });
      return true;
    }

    const input = await body(4_000);
    const token = String(input.token ?? ""), botId = String(input.botId ?? "");
    const bundle = deps.pending.get(token);
    if (!bundle) throw fail(410, "this preview expired; open the link again");
    if (!deps.botName(botId)) throw fail(400, "pick a bot to run it");
    const before = deps.apps.installedFor(botId, bundle.manifest.id, bundle.source);
    const app = deps.apps.install(botId, { manifest: bundle.manifest, html: bundle.html, source: bundle.source, schema: bundle.schema }, owner());
    deps.pending.drop(token);
    deps.json(200, { app, updated: Boolean(before) });
    return true;
  } catch (error) {
    const e = error as Error & { status?: number };
    deps.json(e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message });
  }
  return true;
}
