// 3.0 reconnect card: spot a Composio tool result that clearly says the app's
// sign-in expired or was revoked, so the connector bridge can show a
// "sign in again" card instead of the bot explaining an auth error.
//
// Precision over recall. Only error fields of a failed result are read, never
// the data a successful call returned (an email that mentions "invalid_grant"
// must not raise a card), and only unambiguous auth/expiry wording counts.
// A missing connection, a missing scope (403) or a rate limit is not a
// reconnect: the bot asks for those through MANAGE_CONNECTIONS or retries.

type Json = Record<string, unknown>;

const SLUG = /^[a-z0-9][a-z0-9_-]{0,80}$/;

/** Clear expiry / revocation signals. Each was seen in a real provider error
 * (Google OAuth, Google APIs, Slack, Notion, Composio connected accounts). */
const EXPIRED: RegExp[] = [
  /\binvalid_grant\b/i,
  /\btoken (?:has been |was |is |has )?(?:expired|revoked)\b/i,
  /\b(?:access|refresh|oauth2?|auth(?:entication)?|api|bearer)[ _-]?(?:token|key)\b[^.\n]{0,40}?\b(?:expired|revoked|invalid|no longer valid)\b/i,
  /\b(?:token_expired|token_revoked|expired_token|invalid_token|invalid_auth|account_inactive)\b/i,
  /\bconnected[ _]?account\b[^.\n]{0,100}?\b(?:not active|inactive|expired|revoked|disabled|re-?auth(?:enticat|oriz)\w*)/i,
  /\b401\b[^\n]{0,60}?\b(?:unauthori[sz]ed|unauthenticated)\b/i,
  /\b(?:unauthori[sz]ed|unauthenticated)\b[^\n]{0,60}?\b401\b/i,
  /\bUNAUTHENTICATED\b/,
  /\binvalid authentication credentials\b/i,
  /\bre-?authenticat(?:e|ion) (?:is )?required\b/i,
];

/** Wording that looks like auth but is not an expired sign-in. Checked
 * first: a scope problem mentions "authentication" too. */
const NOT_EXPIRY: RegExp[] = [
  /insufficient (?:authentication )?scopes?/i,
  /\bno (?:active )?connect(?:ed account|ion)s? (?:found|exists?)\b/i,
  /\bconnected account (?:was )?not found\b/i,
];

export function looksExpired(text: string): boolean {
  if (!text) return false;
  if (NOT_EXPIRY.some((pattern) => pattern.test(text))) return false;
  return EXPIRED.some((pattern) => pattern.test(text));
}

/** GMAIL_FETCH_EMAILS → gmail. Composio tool slugs lead with the toolkit. */
export function toolkitOfTool(toolSlug: string): string | null {
  const head = toolSlug.trim().split("_")[0]?.toLowerCase() ?? "";
  if (!head || head === "composio" || head === "bos" || !SLUG.test(head)) return null;
  return head;
}

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);

/** Which toolkits the call addressed, from the request alone. */
function requestedToolkits(toolName: string, args: unknown): string[] {
  const slugs = new Set<string>();
  const direct = toolkitOfTool(toolName);
  if (direct) slugs.add(direct);
  const tools = isObject(args) ? args.tools : undefined;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      const slug = isObject(tool) && typeof tool.tool_slug === "string" ? toolkitOfTool(tool.tool_slug) : null;
      if (slug) slugs.add(slug);
    }
  }
  return [...slugs];
}

function errorText(node: Json, includeData: boolean): string {
  const parts: unknown[] = [];
  for (const key of ["error", "message", "error_description", "detail", "details", "status"]) {
    if (node[key] !== undefined && node[key] !== null) parts.push(node[key]);
  }
  if (includeData && node.data !== undefined) parts.push(node.data);
  return parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join("\n");
}

function hasError(node: Json): boolean {
  const value = node.error;
  if (value === undefined || value === null || value === false) return false;
  return typeof value === "string" ? value.trim().length > 0 : true;
}

/** A failure record: Composio's {successful:false,...} or a result row that
 * carries an error next to its tool slug. A bare "error" key inside some
 * returned data (an email, a sheet row) is not one. */
function isFailure(node: Json, top: boolean): boolean {
  if (node.successful === false) return true;
  if (!hasError(node)) return false;
  return top || "tool_slug" in node || "successful" in node || "status_code" in node;
}

function walk(node: unknown, slug: string | null, top: boolean, found: Set<string>, fallback: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, slug, false, found, fallback);
    return;
  }
  if (!isObject(node)) return;
  const own = typeof node.tool_slug === "string" ? toolkitOfTool(node.tool_slug)
    : typeof node.toolkit === "string" && SLUG.test(node.toolkit.toLowerCase()) ? node.toolkit.toLowerCase()
    : null;
  const current = own ?? slug;
  if (isFailure(node, top) && looksExpired(errorText(node, node.successful === false))) {
    const target = current ?? (fallback.length === 1 ? fallback[0] : null);
    if (target) found.add(target);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    // a successful call's payload is the user's data, never an error report
    if (key === "data" && node.successful === true && !Array.isArray((value as Json | undefined)?.results)) continue;
    walk(value, current, false, found, fallback);
  }
}

/** Toolkit slugs whose sign-in a tools/call result says expired or was revoked. */
export function expiredConnections(toolName: string, args: unknown, result: unknown): string[] {
  if (!isObject(result) || !Array.isArray(result.content)) return [];
  const fallback = requestedToolkits(toolName, args);
  const found = new Set<string>();
  const isError = result.isError === true;
  for (const item of result.content) {
    if (!isObject(item) || item.type !== "text" || typeof item.text !== "string") continue;
    const text = item.text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && typeof parsed === "object" && parsed !== null) {
      walk(parsed, fallback.length === 1 ? fallback[0] : null, isError, found, fallback);
    } else if (isError && fallback.length === 1 && looksExpired(text.slice(0, 4000))) {
      found.add(fallback[0]);
    }
  }
  return [...found];
}
