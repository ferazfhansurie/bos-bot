import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { compatEnv } from "../electron/branding-env.cjs";
import { BOS_SITE } from "./bos-ai.ts";

// The owner's bosbot.my dashboard, on their phone. bosbot.my/data/api answers
// to a bearer token; that token stays in one file on this computer and never
// travels to the phone. The phone asks this server, this server asks the site
// with the token, and the phone only ever sees the numbers. No file, no screen:
// on any other install the endpoint says "not available" and the app hides it.
//
// Point BOS_SITE_DATA_TOKEN_FILE somewhere else to keep the token elsewhere.

export const SITE_DATA_TTL_MS = 60_000;
// A pull to refresh may skip the cache, but not hammer the site.
const FRESH_FLOOR_MS = 10_000;
const MAX_BYTES = 2 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9._~+/=-]{16,512}$/;

export function siteDataTokenFile(env: Record<string, string | undefined> = compatEnv): string {
  return env.BOS_SITE_DATA_TOKEN_FILE || join(homedir(), ".config", "bosbot", "site-data-token");
}

export type SiteDataRead = { data: Record<string, unknown>; fetchedAt: number };
export type SiteData = {
  available(): Promise<boolean>;
  read(options?: { fresh?: boolean }): Promise<SiteDataRead | null>;
};

type Options = { tokenFile?: () => string; url?: string; fetch?: typeof fetch; now?: () => number };

const fail = (message: string) => Object.assign(new Error(message), { status: 502 });

/** People's details stay on the site: the phone gets counts, not contacts. */
export function withoutPeople(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  delete out.who;
  if (out.box && typeof out.box === "object" && !Array.isArray(out.box)) {
    const box: Record<string, unknown> = { ...(out.box as Record<string, unknown>) };
    delete box.account;
    if (Array.isArray(box.sandboxes)) {
      box.sandboxes = box.sandboxes.map(entry => {
        if (!entry || typeof entry !== "object") return entry;
        const { email: _email, ...rest } = entry as Record<string, unknown>;
        return rest;
      });
    }
    out.box = box;
  }
  return out;
}

export function createSiteData(options: Options = {}): SiteData {
  const tokenFile = options.tokenFile ?? (() => siteDataTokenFile());
  const url = options.url ?? `${BOS_SITE}/data/api`;
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let cached: SiteDataRead | null = null;
  let inflight: Promise<SiteDataRead> | null = null;

  async function token(): Promise<string | null> {
    try {
      const text = (await readFile(tokenFile(), "utf8")).trim();
      return TOKEN.test(text) ? text : null;
    } catch {
      return null;
    }
  }

  async function load(key: string): Promise<SiteDataRead> {
    let response: Response;
    try {
      response = await fetcher(url, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw fail("Could not reach bosbot.my.");
    }
    if (response.status === 401 || response.status === 403) throw fail("bosbot.my refused the data token.");
    if (!response.ok) throw fail(`bosbot.my answered ${response.status}.`);
    const text = await response.text();
    if (text.length > MAX_BYTES) throw fail("bosbot.my sent more data than expected.");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw fail("bosbot.my sent something unreadable."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw fail("bosbot.my sent something unreadable.");
    return { data: withoutPeople(parsed as Record<string, unknown>), fetchedAt: now() };
  }

  return {
    async available() {
      return (await token()) !== null;
    },
    async read({ fresh = false } = {}) {
      const key = await token();
      if (!key) {
        cached = null;
        return null;
      }
      const age = cached ? now() - cached.fetchedAt : Infinity;
      if (cached && age < (fresh ? FRESH_FLOOR_MS : SITE_DATA_TTL_MS)) return cached;
      inflight ??= load(key).finally(() => { inflight = null; });
      cached = await inflight;
      return cached;
    },
  };
}
