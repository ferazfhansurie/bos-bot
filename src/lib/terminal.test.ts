import { describe, expect, it, vi } from "vitest";

import { parseTerminalFrame, requestTerminalTicket, resizeFrame, sameTerminalTarget, terminalAvailable, terminalSocketUrl } from "./terminal";

describe("terminal client", () => {
  it("parses only well-formed server frames", () => {
    expect(parseTerminalFrame(JSON.stringify({ type: "ready", cwd: "/tmp/thread" }))).toEqual({ type: "ready", cwd: "/tmp/thread" });
    expect(parseTerminalFrame(JSON.stringify({ type: "output", data: "hi\r\n" }))).toEqual({ type: "output", data: "hi\r\n" });
    expect(parseTerminalFrame(JSON.stringify({ type: "exit", code: 0 }))).toEqual({ type: "exit", code: 0 });
    expect(parseTerminalFrame(JSON.stringify({ type: "error", error: "expired" }))).toEqual({ type: "error", error: "expired" });
    for (const bad of ["not json", JSON.stringify({ type: "output" }), JSON.stringify({ type: "exit", code: "0" }), JSON.stringify({ type: "shell" }), JSON.stringify(null), new ArrayBuffer(2)]) {
      expect(parseTerminalFrame(bad)).toBeNull();
    }
  });

  it("sends bounded positive integer resizes only", () => {
    expect(resizeFrame(80.7, 24.2)).toEqual({ type: "resize", cols: 80, rows: 24 });
    expect(resizeFrame(9000, 9000)).toEqual({ type: "resize", cols: 500, rows: 200 });
    expect(resizeFrame(0, 24)).toBeNull();
    expect(resizeFrame(Number.NaN, 24)).toBeNull();
  });

  it("puts only the ticket in the socket url, on the page's own host", () => {
    expect(terminalSocketUrl("a b/c", { protocol: "http:", host: "127.0.0.1:8787" })).toBe("ws://127.0.0.1:8787/api/terminal?ticket=a%20b%2Fc");
    expect(terminalSocketUrl("t", { protocol: "https:", host: "bos.local" })).toBe("wss://bos.local/api/terminal?ticket=t");
  });

  it("mints a ticket for the bot and thread, never a cwd", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ticket: "tk" }), { status: 201 }));
    await expect(requestTerminalTicket({ botId: "b1", threadId: "th1" }, fetcher as unknown as typeof fetch)).resolves.toBe("tk");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/terminal/ticket");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ botId: "b1", threadId: "th1" });
  });

  it("surfaces the server's refusal", async () => {
    const denied = vi.fn(async () => new Response(JSON.stringify({ error: "local desktop only" }), { status: 403 }));
    await expect(requestTerminalTicket({ botId: "b", threadId: "t" }, denied as unknown as typeof fetch)).rejects.toThrow("local desktop only");
    const missing = vi.fn(async () => new Response("nope", { status: 404 }));
    await expect(requestTerminalTicket({ botId: "b", threadId: "t" }, missing as unknown as typeof fetch)).rejects.toThrow("terminal unavailable (404)");
  });

  it("is offered only in the local desktop app", () => {
    expect(terminalAvailable({ platform: "darwin" })).toBe(true);
    expect(terminalAvailable({ platform: "darwin", remoteClient: { active: true } })).toBe(false);
    expect(terminalAvailable(undefined)).toBe(false);
  });

  it("matches targets by bot and thread", () => {
    expect(sameTerminalTarget({ botId: "b", threadId: "t" }, { botId: "b", threadId: "t" })).toBe(true);
    expect(sameTerminalTarget({ botId: "b", threadId: "t" }, { botId: "b", threadId: "u" })).toBe(false);
    expect(sameTerminalTarget(null, { botId: "b", threadId: "t" })).toBe(false);
  });
});
