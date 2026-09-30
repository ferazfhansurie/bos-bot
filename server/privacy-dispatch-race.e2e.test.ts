import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("revokes a peer send during async setup before the fake provider receives it", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_PRE_DISPATCH_GATE: "privacy-send-gate" });
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = (await api("GET", "/api/bots")).body.bots[0];
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const peer = (await api("POST", "/api/auth/pair", { code: pairing.body.code, label: "Linked peer fixture" })).body;
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "peer send" }, peer.token)).body.task;
    const send = api("POST", `/api/bots/${bot.id}/messages`, { threadId: task.threadId, text: "no provider dispatch" }, peer.token);
    const waiting = join(fixture.info.dataDir, "privacy-send-gate.waiting");
    await expect.poll(() => existsSync(waiting), { timeout: 10_000 }).toBe(true);
    // HTTP acknowledges an admitted send before its background provider
    // setup. The privacy guarantee is that the later dispatch never occurs.
    expect((await send).status).toBe(202);
    const before = (await api("GET", `/api/threads/${task.threadId}/messages`)).body.messages.filter((message: any) => message.role === "user").length;
    expect((await api("PATCH", `/api/bots/${bot.id}`, { visibility: "private" })).status).toBe(200);
    writeFileSync(join(fixture.info.dataDir, "privacy-send-gate"), "go");
    await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((candidate: any) => candidate.id === bot.id)?.tasks.find((candidate: any) => candidate.threadId === task.threadId)?.busy,
      { timeout: 10_000 }).toBe(false);
    expect((await api("GET", `/api/threads/${task.threadId}/messages`)).body.messages.filter((message: any) => message.role === "user").length).toBe(before);
    expect(existsSync(fixture.fixtureDumpPath)).toBe(false);
  } finally { await fixture.close(); }
}, 45_000);
