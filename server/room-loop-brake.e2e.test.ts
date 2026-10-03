import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";

async function withPair(test: (f: any) => Promise<void>) {
  const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const url = session.info.url;
  const env = { OPENMAUSBOT_URL: url };
  const cli = (...args: string[]) => runControlOmb(args, { env }) as Promise<any>;
  const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, url) as Promise<any>;
  // A browser-origin send is a person typing, not a script on loopback.
  const say = (roomId: string, text: string) => request(`/api/groups/${roomId}/messages`, {
    method: "POST", body: JSON.stringify({ text }), headers: { origin: url, "content-type": "application/json" },
  }, url) as Promise<any>;
  const tool = (name: string, args: Record<string, unknown>) => handleToolCall(name, args, (path, options) => request(path, options, url)) as Promise<any>;
  try {
    const ace = (await cli("new-bot", "--name", "Ace", "--section", "A")).bot;
    const bee = (await cli("new-bot", "--name", "Bee", "--section", "A")).bot;
    const room = (await tool("create_channel", { name: "Pair", member_ids: [ace.id, bee.id] })).channel;
    const planPath = join(session.info.dataDir, "room-plan.json");
    const savePlan = (plan: unknown) => writeFileSync(planPath, JSON.stringify(plan));
    const turns = () => existsSync(`${planPath}.evidence.jsonl`)
      ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line).botId) : [];
    const messages = async () => (await api(`/api/threads/${room.activeTaskId}/messages`)).messages;
    const wait = () => cli("wait", "--channel", room.id, "--timeout", "40");
    await test({ url, api, cli, say, ace, bee, room, savePlan, turns, messages, wait, planPath });
  } finally { await session.close(); }
}

it("does not let a bare acknowledgement summon anyone", () => withPair(async f => {
  f.savePlan({ [f.ace.id]: { reply: "agreed @Bee" }, [f.bee.id]: { reply: "should not run" } });
  await f.cli("send-channel", "--channel", f.room.id, "--text", "@Ace start");
  expect((await f.wait()).status).toBe("settled");
  expect(f.turns()).toEqual([f.ace.id]);
}), 60_000);

it("treats a typed stop as the room's Stop button", () => withPair(async f => {
  f.savePlan({ [f.ace.id]: { reply: "@Bee your turn", delayMs: 15_000 }, [f.bee.id]: { reply: "should not run" } });
  await f.cli("send-channel", "--channel", f.room.id, "--text", "@Ace start");
  // Ace is mid-turn once its recent-work brief lands; give the provider a moment to start.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(await f.messages()).some((m: any) => m.kind === "activity")) await new Promise(resolve => setTimeout(resolve, 100));
  await new Promise(resolve => setTimeout(resolve, 2_000));
  // the bulletin is read at each turn start, so editing it mid-turn is safe
  const edited = await f.api(`/api/groups/${f.room.id}`, { bulletin: "use ssh bos-server" }, "PATCH");
  expect(JSON.stringify(edited)).toContain("use ssh bos-server");
  await expect(f.api(`/api/groups/${f.room.id}`, { memberIds: [f.ace.id] }, "PATCH")).rejects.toThrow(/409/);
  const send = () => request(`/api/groups/${f.room.id}/messages`, {
    method: "POST", body: JSON.stringify({ text: "stop", sendId: "4f9d2c1e-7a3b-4c5d-9e8f-0a1b2c3d4e5f" }), headers: { origin: f.url, "content-type": "application/json" },
  }, f.url) as Promise<any>;
  const stopped = await send();
  expect(stopped.stopped).toBe(1);
  // a retried send of the same stop is the same message, not a second stop
  expect((await send()).message?.id).toBe(stopped.message.id);
  // an interrupted turn ends as failed, exactly like the Stop button
  expect((await f.wait()).status).toBe("failed");
  expect(f.turns()).not.toContain(f.bee.id);
  const log = await f.messages();
  expect(log.filter((m: any) => m.role === "user" && m.text === "stop")).toHaveLength(1);
  expect(log.some((m: any) => m.kind === "activity" && m.tool?.name === "stopped 1 running turn in this room")).toBe(true);
  expect(log.some((m: any) => m.text === "@Bee your turn")).toBe(false);
}), 60_000);
