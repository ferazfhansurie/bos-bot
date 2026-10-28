import { describe, expect, it } from "vitest";
import { expiredConnections, looksExpired, toolkitOfTool } from "./connector-auth.ts";

const text = (value: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});

/** Composio's tool-router multi-execute envelope around per-tool rows. */
const multi = (...rows: Array<{ tool_slug: string; response: unknown }>) => ({
  successful: true,
  data: { results: rows.map((row, index) => ({ ...row, index })), total_count: rows.length },
  error: null,
  log_id: "log_x1",
});
const exec = (...slugs: string[]) => ({ tools: slugs.map((tool_slug) => ({ tool_slug, arguments: {} })) });

describe("expiredConnections: clear auth expiry", () => {
  const cases: Array<[string, string, unknown]> = [
    ["google invalid_grant", "GMAIL_FETCH_EMAILS", { successful: false, data: {}, error: "('invalid_grant: Token has been expired or revoked.', {'error': 'invalid_grant', 'error_description': 'Token has been expired or revoked.'})" }],
    ["composio account expired", "GMAIL_SEND_EMAIL", { successful: false, data: {}, error: "Connected account ca_8fK2pQ is not active. Current status: EXPIRED" }],
    ["google 401 client error", "GOOGLECALENDAR_EVENTS_LIST", { successful: false, data: {}, error: "401 Client Error: Unauthorized for url: https://www.googleapis.com/calendar/v3/calendars/primary/events" }],
    ["google UNAUTHENTICATED body", "GOOGLESHEETS_BATCH_GET", { successful: false, data: { error: { code: 401, message: "Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.", status: "UNAUTHENTICATED" } }, error: "Request failed" }],
    ["slack token_revoked", "SLACK_LIST_CONVERSATIONS", { successful: false, data: { ok: false, error: "token_revoked" }, error: "Slack API error" }],
    ["slack invalid_auth", "SLACK_SEND_MESSAGE", { successful: false, data: { ok: false, error: "invalid_auth" }, error: "invalid_auth" }],
    ["notion invalid token", "NOTION_SEARCH_NOTION_PAGE", { successful: false, data: { object: "error", status: 401, code: "unauthorized", message: "API token is invalid." }, error: "API token is invalid." }],
  ];
  for (const [name, tool, response] of cases) {
    it(name, () => {
      const expected = toolkitOfTool(tool)!;
      expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec(tool), text(multi({ tool_slug: tool, response })))).toEqual([expected]);
    });
  }

  it("a plain-text tool error for a single toolkit call", () => {
    expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec("GMAIL_FETCH_EMAILS"),
      text("Error executing GMAIL_FETCH_EMAILS: the access token expired, please reconnect", true))).toEqual(["gmail"]);
  });

  it("a top-level JSON error for a direct toolkit tool", () => {
    expect(expiredConnections("GMAIL_FETCH_EMAILS", {}, text({ error: "Connected account ca_1 is inactive" }, true))).toEqual(["gmail"]);
  });

  it("only the failing toolkit in a mixed batch", () => {
    const result = multi(
      { tool_slug: "GMAIL_FETCH_EMAILS", response: { successful: true, data: { messages: [] }, error: null } },
      { tool_slug: "SLACK_LIST_CONVERSATIONS", response: { successful: false, data: { ok: false, error: "token_expired" }, error: "token_expired" } },
    );
    expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec("GMAIL_FETCH_EMAILS", "SLACK_LIST_CONVERSATIONS"), text(result))).toEqual(["slack"]);
  });
});

describe("expiredConnections: no false positives", () => {
  it("ignores auth words inside the data of a successful call", () => {
    const emails = { successful: true, data: { messages: [
      { messageId: "18c", subject: "prod incident", messageText: "refresh failed with invalid_grant, then 401 Unauthorized. token has been expired or revoked" },
      { messageId: "18d", subject: "fwd", messageText: "Connected account is not active?", error: "quoted from the thread" },
    ] }, error: null };
    expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec("GMAIL_FETCH_EMAILS"), text(multi({ tool_slug: "GMAIL_FETCH_EMAILS", response: emails })))).toEqual([]);
  });

  const failures: Array<[string, unknown]> = [
    ["403 missing scopes", { successful: false, data: { error: { code: 403, message: "Request had insufficient authentication scopes.", status: "PERMISSION_DENIED" } }, error: "Request had insufficient authentication scopes." }],
    ["never connected", { successful: false, data: {}, error: "No connected account found for user default and toolkit gmail" }],
    ["no active connection", { successful: false, data: {}, error: "No active connection found for toolkit(s) 'gmail'" }],
    ["rate limit", { successful: false, data: {}, error: "429 Client Error: Too Many Requests for url: https://gmail.googleapis.com/gmail/v1/users/me/messages" }],
    ["not found", { successful: false, data: { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, error: "404 Client Error: Not Found" }],
    ["validation", { successful: false, data: {}, error: "Invalid request data provided: 'token' field required; invalid_grant_type is not a parameter" }],
    ["server error", { successful: false, data: {}, error: "500 Server Error: Internal Server Error" }],
    ["slack not in channel", { successful: false, data: { ok: false, error: "not_in_channel" }, error: "not_in_channel" }],
    ["expired link in data", { successful: false, data: {}, error: "The share link has expired" }],
  ];
  for (const [name, response] of failures) {
    it(name, () => {
      expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec("GMAIL_FETCH_EMAILS"), text(multi({ tool_slug: "GMAIL_FETCH_EMAILS", response })))).toEqual([]);
    });
  }

  it("ignores plain text that is not an error result", () => {
    expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec("GMAIL_FETCH_EMAILS"), text("your token expired yesterday, says the email"))).toEqual([]);
  });

  it("ignores a plain-text error it cannot pin on one toolkit", () => {
    expect(expiredConnections("COMPOSIO_MULTI_EXECUTE_TOOL", exec("GMAIL_FETCH_EMAILS", "SLACK_SEND_MESSAGE"), text("401 Unauthorized", true))).toEqual([]);
    expect(expiredConnections("COMPOSIO_SEARCH_TOOLS", {}, text("401 Unauthorized", true))).toEqual([]);
  });

  it("never treats composio's own meta tools as a toolkit", () => {
    expect(toolkitOfTool("COMPOSIO_SEARCH_TOOLS")).toBeNull();
    expect(toolkitOfTool("BOS_WHATSAPP_LIST_CHATS")).toBeNull();
    expect(looksExpired("")).toBe(false);
  });
});
