import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("streams only granted peer threads and closes immediately on revocation", async () => {
  const fixture = await launchVerificationServer();
  const request = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const controller = new AbortController();
  let reading: Promise<void> | undefined;
  try {
    const created = await request("POST", "/api/bots", { name: "Peer stream fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    expect(created.status).toBe(201);
    const botId = created.body.bot.id;
    const privateTask = await request("POST", `/api/bots/${botId}/tasks`, { title: "private owner task" });
    const privateThread = privateTask.body.task.threadId;
    const pair = await request("POST", "/api/auth/pairing", { scopes: ["client"] });
    const redeemed = await request("POST", "/api/auth/pair", { code: pair.body.code, label: "BOS multiplayer bridge" });
    const migrated = await request("POST", "/api/multiplayer/peer-migrate", { threads: [] }, redeemed.body.token);
    expect(migrated.status).toBe(200);
    const token = migrated.body.token;
    const sharedTask = await request("POST", `/api/bots/${botId}/tasks`, { title: "shared task" }, token);
    expect(sharedTask.status).toBe(201);
    const sharedThread = sharedTask.body.task.threadId;
    expect((await request("GET", "/api/events", undefined, token)).status).toBe(403);
    const stream = await fetch(`${fixture.info.url}/api/multiplayer/peer-events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    expect(stream.status).toBe(200);
    let transcript = "";
    let ended = false;
    reading = (async () => {
      const reader = stream.body!.getReader();
      try { for (;;) { const result = await reader.read(); if (result.done) { ended = true; break; } transcript += new TextDecoder().decode(result.value); } }
      finally { reader.releaseLock(); }
    })();
    await expect.poll(() => transcript.includes('"hello"')).toBe(true);
    expect((await request("POST", `/api/bots/${botId}/messages`, { text: "private-stream-canary", threadId: privateThread })).status).toBe(202);
    expect((await request("POST", `/api/bots/${botId}/messages`, { text: "shared-stream-visible", threadId: sharedThread, sendId: "scoped-stream-once" }, token)).status).toBe(202);
    await expect.poll(() => transcript.includes("shared-stream-visible"), { timeout: 10_000 }).toBe(true);
    await expect.poll(() => transcript.includes('"kind":"runtime"'), { timeout: 10_000 }).toBe(true);
    expect(transcript).not.toContain("private-stream-canary");
    expect(transcript).not.toContain(privateThread);
    expect(transcript).not.toContain('"raw":');
    expect((await request("POST", "/api/auth/logout", {}, token)).status).toBe(200);
    await expect.poll(() => ended, { timeout: 1500 }).toBe(true);
  } finally {
    controller.abort();
    await reading?.catch(() => {});
    await fixture.close();
  }
}, 45_000);
