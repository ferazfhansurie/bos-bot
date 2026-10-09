import { compatEnv, compatEnvironment } from "../electron/branding-env.cjs";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

// "Say hi to firaz": the last step of first run asks bos.aihlete.com for a
// one-time guest link into a "hi <name>" room on firaz's own server. The app
// server makes the call (not the renderer) because the install id lives in
// the data dir, and so the request carries no app cookies.

export const WELCOME_URL = "https://bos.aihlete.com/api/welcome";
export const WELCOME_TIMEOUT_MS = 10_000;
/** The link must point at firaz's server: hi.aihlete.com, or a host under bos.aihlete.com. */
const WELCOME_HOST = /^(?:(?:[a-z0-9-]+\.)*bos\.aihlete\.com|hi\.aihlete\.com)$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type WelcomeResult =
  | { status: 201; url: string; expiresAt: string }
  | { status: 429 | 503; error: string };

/** The anonymous install id the usage ping already keeps (same file and
 * shape). Created here without `last_attempt_at` when the ping has not run
 * yet, which the ping still treats as its first run. */
export async function welcomeInstallId(dataDir: string): Promise<string> {
  const file = join(dataDir, "anonymous-usage.json");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const id = (JSON.parse(await readFile(file, "utf8")) as { install_id?: unknown })?.install_id;
      if (typeof id === "string" && UUID_V4.test(id)) return id;
      throw Object.assign(new Error("The install id is unreadable."), { status: 503 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if ((error as { status?: number }).status) throw error;
        throw Object.assign(new Error("The install id is unreadable."), { status: 503 });
      }
    }
    const id = randomUUID();
    await mkdir(dataDir, { recursive: true });
    try {
      // wx: if the ping wrote the file a moment ago, keep its id instead.
      const handle = await open(file, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ install_id: id }));
        await handle.sync();
      } finally { await handle.close(); }
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw Object.assign(new Error("The install id is unreadable."), { status: 503 });
}

export function welcomeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim();
  return name.length >= 1 && name.length <= 40 ? name : null;
}

function safeWelcomeUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || !WELCOME_HOST.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** One request, no retries. Anything but a well-formed 201 or a 429 reads
 * as 503, which the app takes as "firaz is offline" and hides the card. */
export async function requestWelcome(
  body: { installId: string; name: string },
  options: { fetch?: typeof fetch; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<WelcomeResult> {
  const env = options.env ?? compatEnv;
  // Until bos-server serves /api/welcome: a fake link for local testing only.
  if (compatEnvironment(env).BOS_WELCOME_STUB === "1") {
    return {
      status: 201,
      url: `https://hi.aihlete.com/pair#code=stub-${body.installId.slice(0, 8)}`,
      expiresAt: new Date((options.now ?? Date.now)() + 15 * 60_000).toISOString(),
    };
  }
  const offline: WelcomeResult = { status: 503, error: "Firaz isn't around right now." };
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(WELCOME_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(WELCOME_TIMEOUT_MS),
    });
  } catch {
    return offline;
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => {});
    return { status: 429, error: "Too many hellos right now. Try again later." };
  }
  if (response.status !== 201) {
    await response.body?.cancel().catch(() => {});
    return offline;
  }
  try {
    const text = await response.text();
    if (text.length > 8192) return offline;
    const parsed = JSON.parse(text) as { url?: unknown; expiresAt?: unknown };
    const url = safeWelcomeUrl(parsed?.url);
    const expiresAt = typeof parsed?.expiresAt === "string" && !Number.isNaN(Date.parse(parsed.expiresAt)) ? parsed.expiresAt : null;
    return url && expiresAt ? { status: 201, url, expiresAt } : offline;
  } catch {
    return offline;
  }
}
