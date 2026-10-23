import { compatEnv } from "../electron/branding-env.cjs";

// BOS AI on desktop: bosbot.my hands this install a relay token tied to the
// person who signed up for the download (one $1 free credit per google
// account). The relay's registration key stays on bosbot.my; the app only
// sends its anonymous install id. When bosbot.my can't tell who downloaded
// it, it returns a claim link the person opens to sign in with google, and
// the app polls for the token.

export const BOS_SITE = (compatEnv.BOS_SITE_URL || "https://bosbot.my").replace(/\/+$/, "");
const TOKEN = /^bosf_[A-Za-z0-9_-]{20,200}$/;
const CODE = /^[A-Za-z0-9_-]{16,64}$/;
// the pairing code the claim page asks for when the link is opened on another network, or to link the bosbot wallet
const PAIR = /^[A-HJ-NP-Z2-9]{6}$/;

export type BosAiToken = { token: string; left: number | null; cap: number | null; model: string | null };
export type BosAiStart = ({ kind: "token" } & BosAiToken) | { kind: "claim"; url: string; code: string; pair?: string };

const fail = (message: string, status = 502) => Object.assign(new Error(message), { status });

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await response.text();
    if (text.length > 8192) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function tokenOf(body: Record<string, unknown> | null): BosAiToken | null {
  if (!body || typeof body.token !== "string" || !TOKEN.test(body.token)) return null;
  return { token: body.token, left: num(body.left), cap: num(body.cap), model: typeof body.model === "string" && /^[a-z0-9][a-z0-9.-]{1,60}$/.test(body.model) ? body.model : null };
}

/** One request, no retries. `link` asks for a claim even when bosbot.my
 * recognises the download, so the person's bosbot credit can be attached. */
export async function startBosAi(installId: string, options: { link?: boolean; fetch?: typeof fetch } = {}): Promise<BosAiStart> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`${BOS_SITE}/api/desktop-trial`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ install: installId, ...(options.link ? { link: true } : {}) }),
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw fail("Could not reach bosbot.my. Check your connection and try again.");
  }
  if (response.status === 429) { await response.body?.cancel().catch(() => {}); throw fail("Too many tries from this network. Try again later.", 429); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail("BOS AI is unavailable right now. Try again in a minute."); }
  const body = await readJson(response);
  const token = tokenOf(body);
  if (token) return { kind: "token", ...token };
  const url = typeof body?.claim === "string" ? body.claim : "";
  const code = typeof body?.code === "string" ? body.code : "";
  const pair = typeof body?.pair === "string" && PAIR.test(body.pair) ? body.pair : undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" && parsed.origin === new URL(BOS_SITE).origin && CODE.test(code) && parsed.searchParams.get("c") === code) return { kind: "claim", url: parsed.toString(), code, ...(pair ? { pair } : {}) };
  } catch {}
  throw fail("bosbot.my returned an invalid response. Try again.");
}

/** pending while the person signs in; the token arrives once; expired after 30 min. */
export async function pollBosAiClaim(code: string, options: { fetch?: typeof fetch } = {}): Promise<{ state: "pending" } | { state: "expired" } | ({ state: "token" } & BosAiToken)> {
  if (!CODE.test(code)) return { state: "expired" };
  const response = await (options.fetch ?? fetch)(`${BOS_SITE}/api/desktop-trial/claim?c=${encodeURIComponent(code)}`, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { state: "expired" }; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw fail("claim check failed"); }
  const body = await readJson(response);
  if (body?.pending === true) return { state: "pending" };
  const token = tokenOf(body);
  if (!token) throw fail("claim check failed");
  return { state: "token", ...token };
}

export type BosAiCredit = { left: number; cap: number; monthFull: boolean };
/** The credit this token has left, for the engine card. "invalid" when the
 * relay refuses the token (a pre-BOS AI install), null when it can't say. */
export async function bosAiCredit(apiUrl: string, token: string, options: { fetch?: typeof fetch } = {}): Promise<BosAiCredit | "invalid" | null> {
  if (!TOKEN.test(token)) return "invalid";
  try {
    const response = await (options.fetch ?? fetch)(`${apiUrl}/usage`, { headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(8_000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return response.status === 401 || response.status === 403 ? "invalid" : null; }
    const body = await readJson(response);
    const left = num(body?.left), cap = num(body?.cap);
    return left === null || cap === null ? null : { left, cap, monthFull: body?.monthFull === true };
  } catch {
    return null;
  }
}
