// Fetching a mini app from an install link. The link comes from the owner but
// points anywhere, so the fetch is the dangerous part: https only, every DNS
// answer must be a public address (pinned for the request, so a rebind can't
// swap in a private one), redirects are followed by hand and checked again,
// and every body is capped. The app's files must sit on the link's own origin.
import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";

import { MINI_APP_LIMITS, manifestFromHtml, manifestLink, normalizeInstallUrl, parseMiniAppManifest, type MiniAppManifest } from "../shared/mini-apps.ts";
import { isPublicDomainAddress } from "./custom-domain.ts";

export class MiniAppError extends Error {}

export interface FetchedFile {
  /** where the body finally came from, after redirects */
  url: string;
  contentType: string;
  body: string;
}
export type MiniAppFetcher = (url: URL, maxBytes: number) => Promise<FetchedFile>;

export interface ResolvedMiniApp {
  manifest: MiniAppManifest;
  html: string;
  /** the link the owner gave */
  source: string;
  /** the page's own bos-app-schema, when the manifest names no collections */
  schema?: string;
  bytes: number;
}

const MAX_REDIRECTS = 3;

interface FetcherOptions {
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
  timeoutMs?: number;
  /** who bos says it is; the 60-second start reads ordinary web pages */
  userAgent?: string;
  /** what it asks for; defaults to a mini app's json or html */
  accept?: string;
}

export function createPublicFetcher(options: FetcherOptions = {}): MiniAppFetcher {
  const lookup = options.lookup ?? ((hostname: string) => dnsLookup(hostname, { all: true, verbatim: true }));
  const timeoutMs = options.timeoutMs ?? 10_000;
  const headers = { Accept: options.accept ?? "application/json, text/html;q=0.9", "User-Agent": options.userAgent ?? "BOS-Bot-app-install" };
  return async (start, maxBytes) => {
    const signal = AbortSignal.timeout(timeoutMs);
    let url = start;
    for (let hop = 0; ; hop++) {
      if (url.protocol !== "https:" || url.username || url.password) throw new MiniAppError("the link redirected somewhere that isn't a plain https address");
      let addresses: LookupAddress[];
      // the deadline covers the lookup too: a stalled resolver must not hang the caller
      try { addresses = await beforeDeadline(lookup(url.hostname.replace(/^\[|\]$/g, "")), signal); } catch {
        throw new MiniAppError(signal.aborted ? `${url.hostname} took too long to answer` : `couldn't find ${url.hostname}`);
      }
      if (!addresses.length || !addresses.every(a => isPublicDomainAddress(a.address))) {
        throw new MiniAppError(`${url.hostname} isn't a public internet address, so bos won't fetch from it`);
      }
      const answer = await get(url, addresses[0]!, maxBytes, signal, headers);
      if (answer.redirect) {
        if (hop >= MAX_REDIRECTS) throw new MiniAppError("the link redirects too many times");
        try { url = new URL(answer.redirect, url); } catch { throw new MiniAppError("the link redirected to a broken address"); }
        continue;
      }
      return { url: url.toString(), contentType: answer.contentType, body: answer.body };
    }
  };
}

function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

function get(url: URL, address: LookupAddress, maxBytes: number, signal: AbortSignal, headers: Record<string, string>): Promise<{ redirect?: string; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_hostname, opts, callback) => {
      if (opts.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    const req = httpsRequest(url, {
      method: "GET", agent: false, lookup, signal, rejectUnauthorized: true,
      headers,
    }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.destroy();
        resolve({ redirect: res.headers.location, contentType: "", body: "" });
        return;
      }
      if (status !== 200) {
        res.destroy();
        reject(new MiniAppError(`${url.hostname} answered ${status || "nothing"} for ${url.pathname}`));
        return;
      }
      const declared = Number(res.headers["content-length"]);
      if (declared > maxBytes) {
        res.destroy();
        reject(new MiniAppError(`${url.pathname} is too big (over ${Math.round(maxBytes / 1024)} KB)`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new MiniAppError(`${url.pathname} is too big (over ${Math.round(maxBytes / 1024)} KB)`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", (error) => reject(error instanceof MiniAppError ? error : new MiniAppError(signal.aborted ? `${url.hostname} took too long to answer` : `couldn't reach ${url.hostname}`)));
    req.end();
  });
}

const looksJson = (file: FetchedFile) => /\bjson\b/i.test(file.contentType) || file.body.trimStart().startsWith("{");

function sameOrigin(base: string, target: URL, what: string) {
  if (target.origin !== new URL(base).origin) throw new MiniAppError(`the app's ${what} must be on ${new URL(base).host}, the same site as the link`);
}

function parseJson(file: FetchedFile): unknown {
  if (Buffer.byteLength(file.body) > MINI_APP_LIMITS.manifestBytes) throw new MiniAppError("the manifest is too big (over 32 KB)");
  try { return JSON.parse(file.body); } catch { throw new MiniAppError("the manifest isn't valid json"); }
}

function checked(raw: unknown, needEntry: boolean): MiniAppManifest {
  const result = parseMiniAppManifest(raw, { needEntry });
  if (!result.ok) throw new MiniAppError(result.error);
  return result.manifest;
}

function page(file: FetchedFile): string {
  if (!/<[a-z!]/i.test(file.body.slice(0, 4096))) throw new MiniAppError("the app's page isn't html");
  return file.body;
}

/** An install link → the manifest and page it describes. Three shapes:
 * a manifest json (its entry next to it), an html page with
 * `<link rel="bos-app-manifest">`, or one html file that carries its own
 * manifest (inline script or bos-app metas). */
export async function resolveInstallLink(input: string, fetch: MiniAppFetcher): Promise<ResolvedMiniApp> {
  const link = normalizeInstallUrl(input);
  if (!link) throw new MiniAppError("use an https link, like bosbot.my/a/crm");
  const first = await fetch(new URL(link), MINI_APP_LIMITS.htmlBytes);

  const fromManifest = async (file: FetchedFile, landing?: FetchedFile): Promise<ResolvedMiniApp> => {
    const manifest = checked(parseJson(file), true);
    const entry = new URL(manifest.entry!, file.url);
    sameOrigin(link, entry, "page");
    let pageFile = landing && entry.toString() === landing.url ? landing : undefined;
    if (!pageFile) {
      pageFile = await fetch(entry, MINI_APP_LIMITS.htmlBytes);
      sameOrigin(link, new URL(pageFile.url), "page");
    }
    const html = page(pageFile);
    return { manifest, html, source: link, bytes: Buffer.byteLength(html) };
  };

  if (looksJson(first)) {
    sameOrigin(link, new URL(first.url), "manifest");
    return fromManifest(first);
  }
  const html = page(first);
  sameOrigin(link, new URL(first.url), "page");
  const pointer = manifestLink(html);
  if (pointer) {
    let target: URL;
    try { target = new URL(pointer, first.url); } catch { throw new MiniAppError("the page's manifest link is broken"); }
    sameOrigin(link, target, "manifest");
    const file = await fetch(target, MINI_APP_LIMITS.manifestBytes);
    sameOrigin(link, new URL(file.url), "manifest");
    return fromManifest(file, first);
  }
  const inline = manifestFromHtml(html);
  if (!inline) throw new MiniAppError("this page isn't a bos app: it has no manifest");
  const manifest = checked(inline, false);
  const schema = typeof (inline as { schema?: unknown }).schema === "string" ? (inline as { schema: string }).schema || undefined : undefined;
  return { manifest, html, source: link, schema, bytes: Buffer.byteLength(html) };
}

/** Apps that ship with bos, built from the starters in skills/apps/templates.
 * They install through the same preview and sandbox as any outside link. */
const BUILTINS: Record<string, { description: string }> = {
  crm: { description: "contacts, deal stages, follow-ups and an activity log" },
};

/** "a: x, y; b: z" (a bos-app-schema) → { a: "x, y", b: "z" } */
export function schemaCollections(schema: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (schema ?? "").split(/;\s*(?=[a-z][a-z0-9_]*\s*:)/)) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*:\s*([\s\S]*)$/.exec(part);
    if (m) out[m[1]!] = m[2]!.trim();
  }
  return out;
}

export async function builtinMiniApp(id: string, readTemplate: (name: string) => Promise<string>): Promise<ResolvedMiniApp | null> {
  const builtin = Object.hasOwn(BUILTINS, id) ? BUILTINS[id]! : null;
  if (!builtin) return null;
  const html = await readTemplate(id);
  const meta = manifestFromHtml(html) as { name?: string; icon?: string; schema?: string } | null;
  const manifest = checked({ id, name: meta?.name ?? id, version: "1.0.0", icon: meta?.icon, author: "bos bot", description: builtin.description, collections: schemaCollections(meta?.schema) }, false);
  return { manifest, html, source: `builtin:${id}`, bytes: Buffer.byteLength(html) };
}
