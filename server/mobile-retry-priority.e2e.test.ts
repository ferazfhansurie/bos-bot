import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("reconciles a lost phone send response even when retry delivery priority changes", async () => {
  const fixture = await launchVerificationServer({});
  const api = async (path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, data: await response.json() as any };
  };
  try {
    const created = await api("/api/bots", { name: "Retry fixture" });
    expect(created.status).toBe(201);
    const bot = created.data.bot;
    const send = { text: "one synthetic message", threadId: bot.threadId, sendId: "phone_priority_retry_123456" };
    const first = await api(`/api/bots/${bot.id}/messages`, { ...send, priority: "block" });
    expect([200, 202]).toContain(first.status);
    // Pretend the phone lost that response and restarted. Its durable draft
    // reuses the sendId, although the idle composer now offers normal queue.
    const retry = await api(`/api/bots/${bot.id}/messages`, { ...send, priority: "queue" });
    expect([200, 202]).toContain(retry.status);
    const page = await api(`/api/threads/${bot.threadId}/messages?limit=50`);
    expect(page.data.messages.filter((row: any) => row.sendId === send.sendId)).toHaveLength(1);
    const edited = await api(`/api/bots/${bot.id}/messages`, { ...send, text: "different message", priority: "queue" });
    expect(edited.status).toBe(409);
  } finally {
    await fixture.close();
  }
}, 30_000);
