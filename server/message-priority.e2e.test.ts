import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../scripts/control-omb.ts";
let fixture: VerificationServer;
const evidence: unknown[] = [];
async function api(method: string, path: string, body?: unknown) {
  const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const result = { status: response.status, body: await response.json() as any };
  evidence.push({ method, path, body, result }); return result;
}
const messages = async (thread: string) => (await api("GET", `/api/threads/${thread}/messages?limit=100`)).body.messages as any[];
async function bot() { const b = (await runControlOmb(["new-bot", "--name", "Priority fixture", "--url", fixture.info.url]) as any).bot; return { ...b, threadId: b.activeTaskId }; }
beforeEach(async () => {
  evidence.length = 0;
  fixture = await launchVerificationServer();
  const wrapper = join(fixture.info.dataDir, "priority-fake.mjs");
  writeFileSync(wrapper, ["#!/usr/bin/env node", 'import {readFileSync} from "node:fs";', 'const text = process.argv.join(" ");', 'process.env.FAKE_CLAUDE_MODE="slow";', `process.env.FAKE_CLAUDE_SLOW_FINISH_GATE=${JSON.stringify(join(fixture.info.dataDir, "finish.gate"))};`, `process.env.FAKE_CLAUDE_STEER_RECEIVED=${JSON.stringify(join(fixture.info.dataDir, "steered.txt"))};`, `process.env.FAKE_CLAUDE_DUMP=${JSON.stringify(join(fixture.info.dataDir, "launch.json"))};`, `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`].join("\n"), {mode:0o700});
  expect((await api("PATCH", "/api/instances/claude", {cli:wrapper})).status).toBe(200);
}, 30_000);
afterEach(async () => { if (!fixture) return; writeFileSync(`${fixture.info.logPath}.priority.json`, JSON.stringify({fixture:fixture.info,evidence},null,2)); console.info(`${fixture.info.logPath}.priority.json`); await fixture.close(); });
async function started() { await expect.poll(() => existsSync(join(fixture.info.dataDir,"launch.json")), {timeout:15000}).toBe(true); }
it("queues default direct messages until the current turn ends and block preempts without losing the queue", async () => {
  const b=await bot(), route=`/api/bots/${b.id}/messages`;
  expect((await api("POST",route,{text:"FIRST_TURN"})).status).toBe(202); await started();
  const queued=await api("POST",route,{text:"QUEUED_INPUT",sendId:"queued-input-0001"});
  expect(queued.body).toMatchObject({queued:true});
  expect((await messages(b.threadId)).some(m=>m.text==="QUEUED_INPUT")).toBe(false);
  expect(existsSync(join(fixture.info.dataDir,"steered.txt"))).toBe(false);
  const block=await api("POST",route,{text:"BLOCK_INPUT",priority:"block",sendId:"block-input-00001"});
  expect(block.status).toBe(202); expect(block.body.queued).not.toBe(true);
  await expect.poll(async()=> (await messages(b.threadId)).filter(m=>m.role==="user").map(m=>m.text)).toEqual(["FIRST_TURN","BLOCK_INPUT"]);
  const retry=await api("POST",route,{text:"BLOCK_INPUT",priority:"block",sendId:"block-input-00001"}); expect(retry.body.message.id).toBe(block.body.message.id);
  writeFileSync(join(fixture.info.dataDir,"finish.gate"),"finish");
  await expect.poll(async()=> (await messages(b.threadId)).filter(m=>m.role==="user").map(m=>m.text),{timeout:15000}).toEqual(["FIRST_TURN","BLOCK_INPUT","QUEUED_INPUT"]);
}, 40_000);
it("queues room messages and block interrupts the addressed running room turn", async()=>{
  const b=await bot(); const room=(await api("POST","/api/groups",{name:"Priority room",memberIds:[b.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:b.id}}})).body.group;
  const route=`/api/groups/${room.id}/messages`;
  expect((await api("POST",route,{text:"ROOM_FIRST"})).status).toBe(202); await started();
  const queued=await api("POST",route,{text:"ROOM_QUEUED"}); expect(queued.body.queued).toBe(true);
  expect((await messages(room.threadId)).some(m=>m.text==="ROOM_QUEUED")).toBe(false);
  expect((await api("GET","/api/bots?messages=0")).body.botQueuedMessages[room.threadId]).toEqual([{queueId:queued.body.queueId,text:"ROOM_QUEUED"}]);
  const block=await api("POST",route,{text:"ROOM_BLOCK",priority:"block"}); expect(block.status).toBe(202); expect(block.body.queued).not.toBe(true);
  expect((await messages(room.threadId)).filter(m=>m.role==="user").map(m=>m.text)).toEqual(["ROOM_FIRST","ROOM_BLOCK"]);
  writeFileSync(join(fixture.info.dataDir,"finish.gate"),"finish");
  await expect.poll(async()=> (await messages(room.threadId)).filter(m=>m.role==="user").map(m=>m.text),{timeout:15000}).toEqual(["ROOM_FIRST","ROOM_BLOCK","ROOM_QUEUED"]);
},40_000);
it("rejects invalid priorities on both message routes",async()=>{
  const b=await bot(); const room=(await api("POST","/api/groups",{name:"Validate",memberIds:[b.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:b.id}}})).body.group;
  for(const route of [`/api/bots/${b.id}/messages`,`/api/groups/${room.id}/messages`]) expect((await api("POST",route,{text:"invalid",priority:"urgent"})).status).toBe(400);
});
it("serializes overlapping block sends so each starts ahead of the pending queue", async () => {
  const b=await bot(), route=`/api/bots/${b.id}/messages`;
  await api("POST",route,{text:"RUNNING"}); await started();
  const queued=await api("POST",route,{text:"LATER"}); expect(queued.body.queued).toBe(true);
  const replies=await Promise.all([api("POST",route,{text:"BLOCK_A",priority:"block"}),api("POST",route,{text:"BLOCK_B",priority:"block"})]);
  expect(replies.map(r=>r.status)).toEqual([202,202]);
  expect(replies.some(r=>r.body.queued===true)).toBe(false);
  expect((await messages(b.threadId)).filter(m=>m.role==="user").map(m=>m.text)).toEqual(["RUNNING","BLOCK_A","BLOCK_B"]);
},40_000);

it("normal Send steers only the correction; Stop pauses After this until Resume", async () => {
  const b = await bot(), route = `/api/bots/${b.id}/messages`;
  await api("POST", route, { text: "KEEP_WORKING" });
  await started();
  await expect.poll(async () => (await messages(b.threadId)).some(m => m.kind === "activity"), { timeout: 15000 }).toBe(true);
  const after = await api("POST", route, { text: "AFTER_THIS_ONLY", priority: "queue", sendId: "after-this-once-001" });
  expect(after.body.queued).toBe(true);
  const steered = await api("POST", route, { text: "CHANGE_THIS_WORK", priority: "steer", sendId: "steer-this-once-001" });
  expect(steered.status).toBe(202);
  expect(steered.body.steered).toBe(true);
  expect(steered.body.messages.map((m: any) => m.text)).toEqual(["CHANGE_THIS_WORK"]);
  expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages[b.threadId]).toEqual([{ queueId: after.body.queueId, text: "AFTER_THIS_ONLY" }]);
  await expect.poll(() => existsSync(join(fixture.info.dataDir, "steered.txt")), { timeout: 15000 }).toBe(true);
  expect((await api("POST", `/api/bots/${b.id}/interrupt`, { threadId: b.threadId })).status).toBe(200);
  await expect.poll(async () => (await api("GET", "/api/bots?messages=0")).body.bots.find((x: any) => x.id === b.id)?.busy).toBe(false);
  expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages[b.threadId]).toEqual([{ queueId: after.body.queueId, text: "AFTER_THIS_ONLY", paused: true }]);
  expect((await messages(b.threadId)).some(m => m.text === "AFTER_THIS_ONLY")).toBe(false);
  const retry = await api("POST", route, { text: "CHANGE_THIS_WORK", priority: "steer", sendId: "steer-this-once-001" });
  expect(retry.body.message.id).toBe(steered.body.message.id);
  const stale = await api("POST", `/api/bots/${b.id}/queue/${after.body.queueId}/steer`, { threadId: b.threadId });
  expect(stale.body).toMatchObject({ queued: true, paused: true });
  expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages[b.threadId][0].paused).toBe(true);
  writeFileSync(join(fixture.info.dataDir, "finish.gate"), "finish");
  expect((await api("POST", `/api/bots/${b.id}/queue/resume`, { threadId: b.threadId })).status).toBe(200);
  await expect.poll(async () => (await messages(b.threadId)).filter(m => m.text === "AFTER_THIS_ONLY").length, { timeout: 15000 }).toBe(1);
}, 40000);

it("room Stop holds pending work rather than cancelling it", async () => {
  const b = await bot();
  const room = (await api("POST", "/api/groups", { name: "Pause fixture", memberIds: [b.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: b.id } } })).body.group;
  const route = `/api/groups/${room.id}/messages`;
  await api("POST", route, { text: "ROOM_WORK" }); await started();
  const queued = await api("POST", route, { text: "ROOM_LATER", priority: "queue" });
  expect(queued.body.queued).toBe(true);
  await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
  expect((await api("GET", "/api/bots?messages=0")).body.botQueuedMessages[room.threadId]).toEqual([{ queueId: queued.body.queueId, text: "ROOM_LATER", paused: true }]);
  writeFileSync(join(fixture.info.dataDir, "finish.gate"), "finish");
  expect((await api("POST", `/api/groups/${room.id}/queue/resume`, { threadId: room.threadId })).status).toBe(200);
  await expect.poll(async () => (await messages(room.threadId)).filter(m => m.text === "ROOM_LATER").length, { timeout: 15000 }).toBe(1);
}, 40000);

it("After this addressed to an idle room member still waits, and a goal is never steered", async () => {
  const a = await bot(), b = await bot();
  await api("PATCH", `/api/bots/${a.id}`, { name: "alpha" });
  await api("PATCH", `/api/bots/${b.id}`, { name: "beta" });
  const room = (await api("POST", "/api/groups", { name: "Explicit intent", memberIds: [a.id, b.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: a.id } } })).body.group;
  const route = `/api/groups/${room.id}/messages`;
  await api("POST", route, { text: "@alpha start work" }); await started();
  const queued = await api("POST", route, { text: "@beta after this", priority: "queue" });
  expect(queued.body.queued).toBe(true);
  expect((await messages(room.threadId)).some(m => m.text === "@beta after this")).toBe(false);
  const goal = await api("POST", route, { text: "separate goal", mode: "goal", priority: "steer" });
  expect(goal.body.queued).toBe(true);
  expect(goal.body.steered).not.toBe(true);
  const explicit = await api("POST", `/api/groups/${room.id}/queue/${goal.body.queueId}/steer`, { threadId: room.threadId });
  expect(explicit.body.steered).not.toBe(true);
  await api("POST", `/api/groups/${room.id}/interrupt`, { threadId: room.threadId });
}, 40000);
