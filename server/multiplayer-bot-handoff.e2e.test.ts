import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("lets a room bot hand off to another bot once, without looping back", async () => {
  const state = join(mkdtempSync(join(tmpdir(), "omb-handoff-")), "replies");
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_REPLIES: JSON.stringify(["on it. @Beta can you check the numbers?", "checked, they add up. @Alpha back to you.", "should never run"]),
    FAKE_CLAUDE_REPLY_STATE: state,
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const create = async (name: string) => (await api("POST", "/api/bots", {
      name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true,
    })).body.bot;
    const alpha = await create("Alpha");
    const beta = await create("Beta");
    const me = await api("GET", "/api/multiplayer/me");
    const dm = await api("POST", "/api/multiplayer/dm", { targetId: `${me.body.homeId}:bot:${alpha.id}` });
    const roomId = dm.body.room.id;
    const sent = await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "please total these", sendId: "handoff-send-1" });
    expect(sent.status).toBe(201);
    const botReplies = async () => (await api("GET", `/api/multiplayer/rooms/${roomId}/messages`)).body.messages
      .filter((message: any) => message.actor.kind === "bot" && message.kind !== "activity" && message.text);
    await expect.poll(async () => (await botReplies()).length, { timeout: 25_000, interval: 250 }).toBe(2);
    const [first, second] = await botReplies();
    expect(first).toMatchObject({ actor: { localId: alpha.id }, responseTo: sent.body.message.id });
    expect(second).toMatchObject({ actor: { localId: beta.id }, responseTo: first.id, text: expect.stringContaining("@Alpha") });
    // Alpha already spoke in this chain, so Beta's mention must not wake it again.
    await new Promise(resolve => setTimeout(resolve, 3_000));
    expect((await botReplies()).length).toBe(2);
  } finally {
    await fixture.close();
  }
}, 60_000);
