import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { openSse } from "./testing/sse.ts";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

// Real server + fake CLI fixtures. Each case owns a disposable HOME so
// title/digest/incident helper calls cannot overwrite another case's CLI dump.

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const FAKE_CLAUDE = join(SERVER_DIR, "testing", "fake-claude-cli.ts");
const TEST_CAPABILITY_KEY = "room-chat-wait-fixture-capability";



const sockets: Socket[] = [];
let child: ChildProcess;
let home = "";
let base = "";
let stderr = "";
let patientFinishGate = "";



const api = async (
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

const fixture = (displayName: string, environment: Record<string, string>) => ({
  driver: "claudeAgent",
  displayName,
  environment,
  config: { cli: FAKE_CLAUDE },
});

beforeEach(async () => {
  stderr=""; sockets.length=0;
  home = mkdtempSync(join(tmpdir(), "omb-room-parallel-"));
  const data = join(home, ".openmausbot");
  const staticDir = join(home, "static");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(staticDir, "assets"), { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Room parallel test</title>");
  writeFileSync(join(staticDir, "assets", "smoke.css"), "body{}");
  patientFinishGate = join(home, "patient-finish");
  writeFileSync(patientFinishGate, "initial turns may finish");
  // Scope fake CLI dumps to its actual execution owner; incident helpers can
  // use the same provider instance without overwriting a room approval socket.
  const approvalCli=join(home,"approval-cli.mjs");
  const approvalDumps=join(home,"approval-dumps"); mkdirSync(approvalDumps);
  writeFileSync(approvalCli, `#!/usr/bin/env node
import {readFileSync} from "node:fs";
import {join} from "node:path";
const at=process.argv.indexOf("--mcp-config");
const servers=at<0?{}:JSON.parse(readFileSync(process.argv[at+1],"utf8")).mcpServers;
const thread=Object.values(servers).map(server=>server.env?.OMB_THREAD_ID??(server.env?.OMB_GATE_UPSTREAM?JSON.parse(server.env.OMB_GATE_UPSTREAM).env?.OMB_THREAD_ID:undefined)).find(Boolean)??"probe";
process.env.FAKE_CLAUDE_DUMP=join(process.env.FAKE_APPROVAL_DUMP_DIR,thread+".json");
await import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE).href)});
`,{mode:0o755});
  writeFileSync(join(data, "config.json"), JSON.stringify({
    instances: {
      // A gate keeps a direct turn busy until the test observes the room's
      // wait, rather than racing the fake CLI's 800ms closing reply. The
      // closing reply echoes the prompt, so a room reply carries the room's
      // own @mentions back out
      approvalA: {...fixture("Approval A", { FAKE_CLAUDE_MODE: "hang", FAKE_APPROVAL_DUMP_DIR: approvalDumps, FAKE_CLAUDE_TEXT_DUMP: join(home,"approvalA-text.json") }),config:{cli:approvalCli}},
      approvalB: {...fixture("Approval B", { FAKE_CLAUDE_MODE: "hang", FAKE_APPROVAL_DUMP_DIR: approvalDumps, FAKE_CLAUDE_TEXT_DUMP: join(home,"approvalB-text.json") }),config:{cli:approvalCli}},
      loopA: fixture("Loop A", { FAKE_CLAUDE_REPLIES: JSON.stringify(Array(10).fill("@LoopB continue")), FAKE_CLAUDE_REPLY_STATE: join(home,"loopA-replies.txt") }),
      loopB: fixture("Loop B", { FAKE_CLAUDE_REPLIES: JSON.stringify(Array(10).fill("@LoopA continue")), FAKE_CLAUDE_REPLY_STATE: join(home,"loopB-replies.txt") }),
      chainA: fixture("Chain A", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@ChainB check the route"]) }),
      chainB: fixture("Chain B", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@ChainC check the queue"]) }),
      chainC: fixture("Chain C", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@ChainD check the handoff"]) }),
      chainD: fixture("Chain D", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@ChainE verify the result"]) }),
      chainE: fixture("Chain E", { FAKE_CLAUDE_REPLIES: JSON.stringify(["verified the result"]) }),
      callbackC: fixture("Callback C", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@ChainA the checks passed"]) }),
      director: fixture("Director", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@Reviewer check route", "@Builder implement route", "REVIEWED FINAL RESULT"]), FAKE_CLAUDE_REPLY_STATE: join(home, "director-replies.txt") }),
      reviewer: fixture("Reviewer", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@Director route checked"]) }),
      builder: fixture("Builder", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@Director implementation checked"]) }),
      parallelLead: fixture("Parallel lead", { FAKE_CLAUDE_REPLIES: JSON.stringify(["@Worker1 @Worker2 @Worker3 @Worker4 @Worker5 check your part", ...Array.from({length:5}, (_,i)=>`REVIEWED RESULT ${i+1}`)]), FAKE_CLAUDE_REPLY_STATE: join(home, "parallel-lead-replies.txt") }),
      ...Object.fromEntries(Array.from({length:5}, (_,i)=>[`worker${i+1}`, fixture(`Worker ${i+1}`, { FAKE_CLAUDE_REPLIES: JSON.stringify([`@Lead RESULT ${i+1}`]), FAKE_CLAUDE_TOOL_RESULT_GATE: join(home, "workers-tool.gate") })])),
      questionA: { driver: "codex", config: { cli: join(SERVER_DIR,"testing","fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE:"question", FAKE_CODEX_ASK_HOLD:"1" } },
      questionB: { driver: "codex", config: { cli: join(SERVER_DIR,"testing","fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE:"question", FAKE_CODEX_ASK_HOLD:"1" } },
      refuse: { driver: "codex", config: { cli: join(SERVER_DIR,"testing","fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE:"question", FAKE_CODEX_ASK_HOLD:"1", FAKE_CODEX_STEER_ERROR: JSON.stringify({ code: -32000, message: "active turn is not steerable" }) } },
      unknown: { driver: "codex", config: { cli: join(SERVER_DIR,"testing","fake-codex-app-server.ts") }, environment: { FAKE_CODEX_MODE:"question", FAKE_CODEX_ASK_HOLD:"1", FAKE_CODEX_STEER_HANG:"1", FAKE_CODEX_STEER_TIMEOUT_MS:"1000" } },
      patient: fixture("Patient fixture", { FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: patientFinishGate }),
      held: fixture("Held fixture", { FAKE_CLAUDE_MODE: "stream", FAKE_CLAUDE_TOOL_RESULT_GATE: patientFinishGate }),
      quick: fixture("Quick fixture", { FAKE_CLAUDE_MODE: "stream" }),
      lead: fixture("Lead fixture", { FAKE_CLAUDE_REPLIES: JSON.stringify(["handing off @Slow", "LEAD ANSWERED ASIDE"]), FAKE_CLAUDE_REPLY_STATE: join(home,"lead-replies.txt") }),

    },
  }));
  const port = await freePortBlock([0, 1]);
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: staticDir,
      OMB_TEST_INTERNAL_CAPABILITY_KEY: TEST_CAPABILITY_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr!.on("data", (chunk) => (stderr += chunk));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}: ${stderr}`);
    try {
      if ((await fetch(`${base}/api/health`)).status === 200) break;
    } catch {
      // Still starting.
    }
    if (Date.now() >= deadline) throw new Error(`server never became healthy: ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 30_000);

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  if (home) await removeTempDir(home);
});


const createBot = async (name: string, instanceId: string) => {
  const instances = (await api("GET","/api/instances")).body.instances;
  const model = instances.find((i:any)=>i.instanceId===instanceId).models.default;
  return (await api("POST", "/api/bots", { name, computer: "off", modelSelection: { instanceId, model }, requireAvailableModel: true })).body.bot;
};
const askPermission = async (runtimeId: string, id: string) => {
  const path=join(home,"approval-dumps",`${runtimeId}.json`);
  await wait(async()=>existsSync(path),`owned provider dump ${runtimeId}`);
  const launched = JSON.parse(readFileSync(path,"utf8"));
  const socket = connect(launched.mcpConfig.mcpServers.ogb.args.at(-1)); sockets.push(socket);
  await new Promise<void>((resolve,reject)=>{socket.once("connect",resolve);socket.once("error",reject);});
  const answers:any[]=[]; createInterface({input:socket}).on("line",line=>answers.push(JSON.parse(line)));
  socket.write(`${JSON.stringify({t:"ask",id,kind:"permission",tool:"Bash",input:{command:"ls -la ./dist"}})}\n`);
  return answers;
};
const snapshot = async (id: string) => (await api("GET", "/api/bots?messages=100")).body.groups.find((g: any)=>g.id===id);
const wait = async (predicate: ()=>Promise<boolean>, phase="condition") => { const end=Date.now()+15000; while(!await predicate()) { if(Date.now()>end) throw new Error(`${phase} not reached: ${stderr.slice(-1500)} `); await new Promise(r=>setTimeout(r,100)); } };

describe("room runtime concurrency", { timeout: 45000 }, () => {
  it("keeps refused room text visible in bot.queued without delivery activity spam", async () => {
    const slow = await createBot("Refuser", "refuse");
    const other = await createBot("Other", "quick");
    const room = (await api("POST", "/api/groups", { name: "Quiet queue", memberIds: [slow.id, other.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@Refuser START" });
    await wait(async () => (await snapshot(room.id)).messages.some((message:any) => message.card?.requestId && !message.card.answered));
    for (const patch of [{ bulletin: "Changed while card open" }, { memberIds: [other.id] }]) {
      expect((await api("PATCH", `/api/groups/${room.id}`, patch)).status).toBe(409);
    }
    const events = await openSse(`${base}/api/events`);
    try {
      const text = "@Refuser PENDING TEXT";
      const sent = await api("POST", `/api/groups/${room.id}/messages`, { text });
      expect(sent.body.queued).toBe(true);
      const queued = await events.until(frame => frame.kind === "bot.queued" && frame.queues?.[room.threadId]?.some((item:any) => item.queueId === sent.body.queueId));
      expect(queued.queues[room.threadId].find((item:any) => item.queueId === sent.body.queueId).text).toBe(text);
      const refused = await api("POST", `/api/groups/${room.id}/queue/${sent.body.queueId}/steer`, { botId: slow.id });
      expect(refused.body.queued).toBe(true);
      const messages = (await snapshot(room.id)).messages;
      expect(messages.some((message:any) => /not delivered yet:|consumption is unconfirmed/.test(message.tool?.name ?? ""))).toBe(false);
      expect(messages.some((message:any) => message.text === text)).toBe(false);
      expect((await api("DELETE", `/api/groups/${room.id}/queue/${sent.body.queueId}`)).status).toBe(200);
    } finally { events.close(); }
  });

  it("retains one outcome_unknown warning for an explicit room steer without replaying it", async () => {
    const slow = await createBot("Unknown", "unknown");
    const room = (await api("POST", "/api/groups", { name: "Unknown queue", memberIds: [slow.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    await api("POST", `/api/groups/${room.id}/messages`, { text: "@Unknown START" });
    await wait(async () => (await snapshot(room.id)).messages.some((message:any) => message.card?.requestId && !message.card.answered));
    const text = "@Unknown UNCERTAIN TEXT";
    const queued = await api("POST", `/api/groups/${room.id}/messages`, { text });
    expect(queued.body.queued).toBe(true);
    const steered = await api("POST", `/api/groups/${room.id}/queue/${queued.body.queueId}/steer`, { botId: slow.id });
    expect(steered.body).toMatchObject({ outcomeUnknown: true, delivery: "outcome_unknown", consumption: "unconfirmed" });
    const messages = (await snapshot(room.id)).messages;
    expect(messages.filter((message:any) => message.text === text)).toHaveLength(1);
    expect(messages.filter((message:any) => /delivery outcome unknown/.test(message.tool?.name ?? ""))).toHaveLength(1);
    expect(messages.find((message:any) => message.text === text).steerDelivery).toBe("outcome_unknown");
    expect((await api("DELETE", `/api/groups/${room.id}/queue/${queued.body.queueId}`)).status).toBe(404);
  });

  it("answers an unaddressed message through the default responder while another member is mid-turn", async () => {
    const slow = await createBot("Slow", "patient"); const quick = await createBot("Quick", "quick");
    const room = (await api("POST", "/api/groups", { name:"Lead", memberIds:[quick.id,slow.id], setup:{ bulletin:"",defaultResponder:{kind:"member",botId:quick.id} } })).body.group;
    rmSync(patientFinishGate,{force:true});
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow LONG JOB"})).status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id))?.activeBotIds?.includes(slow.id)),"slow running");
    const aside=await api("POST",`/api/groups/${room.id}/messages`,{text:"UNADDRESSED ASIDE"});
    expect(aside.status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id)).messages.some((m:any)=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===quick.id)),"default responder reply");
    writeFileSync(patientFinishGate,"done");
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });

  it("answers the lead mid-hop: the lead's next message is not held behind the teammate it handed off to", async () => {
    const slow = await createBot("Slow", "patient"); const lead = await createBot("Lead", "lead");
    const room = (await api("POST", "/api/groups", { name:"Hop", memberIds:[lead.id,slow.id], setup:{ bulletin:"",defaultResponder:{kind:"member",botId:lead.id} } })).body.group;
    rmSync(patientFinishGate,{force:true});
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"START"})).status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id))?.activeBotIds?.includes(slow.id)),"handed-off member running");
    const aside=await api("POST",`/api/groups/${room.id}/messages`,{text:"UNADDRESSED ASIDE"});
    expect(aside.status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id)).messages.some((m:any)=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===lead.id&&m.text.includes("LEAD ANSWERED ASIDE"))),"lead answers while the hop runs");
    expect((await snapshot(room.id)).activeBotIds).toContain(slow.id);
    writeFileSync(patientFinishGate,"done");
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });

  for (const via of ["owner", "paired session"] as const) it(`answers an @mention of the lead mid-hop from the ${via}`, async () => {
    const slow = await createBot("Slow", "patient"); const lead = await createBot("Lead", "lead");
    const room = (await api("POST", "/api/groups", { name:"Hop", memberIds:[lead.id,slow.id], setup:{ bulletin:"",defaultResponder:{kind:"member",botId:lead.id} } })).body.group;
    let headers: Record<string,string> = {};
    if (via === "paired session") {
      const pairing = await api("POST", "/api/auth/pairing", { scopes: ["admin","client"] });
      const paired = await api("POST", "/api/auth/pair", { code: pairing.body.code, label: "lead cli" });
      expect(paired.status).toBe(200);
      headers = { authorization: `Bearer ${paired.body.token}` };
    }
    rmSync(patientFinishGate,{force:true});
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"START"})).status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id))?.activeBotIds?.includes(slow.id)),"handed-off member running");
    const aside=await api("POST",`/api/groups/${room.id}/messages`,{text:"@Lead ADDRESSED ASIDE"},headers);
    expect(aside.status).toBe(202);
    expect(aside.body.queued).toBeUndefined();
    await wait(async()=>Boolean((await snapshot(room.id)).messages.some((m:any)=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===lead.id&&m.text.includes("LEAD ANSWERED ASIDE"))),"lead answers the addressed aside while the hop runs");
    writeFileSync(patientFinishGate,"done");
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });

  it("still answers an @mention when the room context names the phone and another member's turn holds it", async () => {
    const slow = await createBot("Slow", "patient"); const quick = await createBot("Quick", "quick");
    const room = (await api("POST", "/api/groups", { name:"Phone", memberIds:[quick.id,slow.id], setup:{ bulletin:"",defaultResponder:{kind:"member",botId:quick.id} } })).body.group;
    rmSync(patientFinishGate,{force:true});
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow LONG JOB, check it on the phone"})).status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id))?.activeBotIds?.includes(slow.id)),"phone holder running");
    const aside=await api("POST",`/api/groups/${room.id}/messages`,{text:"@Quick ADDRESSED ASIDE"});
    expect(aside.status).toBe(202);
    expect(aside.body.queued).toBeUndefined();
    await wait(async()=>Boolean((await snapshot(room.id)).messages.some((m:any)=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===quick.id)),"addressed member answers without the held phone");
    expect((await snapshot(room.id)).messages.some((m:any)=>m.kind==="activity"&&m.from?.botId===quick.id&&/phone is in use/.test(m.tool?.name??""))).toBe(true);
    writeFileSync(patientFinishGate,"done");
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });

  it("admits two addressed members independently, steers one without interruption, and stops room work without stopping a private sibling", async () => {
    const slow = await createBot("Slow", "patient"); const quick = await createBot("Quick", "quick");
    const room = (await api("POST", "/api/groups", { name:"Parallel", memberIds:[slow.id,quick.id], setup:{ bulletin:"",defaultResponder:{kind:"mentions"} } })).body.group;
    rmSync(patientFinishGate,{force:true});
    expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow FIRST"})).status).toBe(202);
    await wait(async()=>Boolean((await snapshot(room.id))?.activeBotIds?.includes(slow.id)));
    const next=await api("POST",`/api/groups/${room.id}/messages`,{text:"@Quick SECOND"});
    expect(next.status).toBe(202); expect(next.body.queued).not.toBe(true);
    await wait(async()=>Boolean((await snapshot(room.id)).messages.some((m:any)=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===quick.id)));
    expect((await snapshot(room.id)).activeBotIds).toContain(slow.id);
    // A default send queues; the explicit action folds it into the running turn.
    const correction=await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow CORRECTION"});
    expect(correction.body.queued).toBe(true);
    expect((await api("POST",`/api/groups/${room.id}/queue/${correction.body.queueId}/steer`,{botId:slow.id})).body.steered).toBe(true);
    writeFileSync(patientFinishGate,"finish the steered room turn");
    await wait(async()=>!(await snapshot(room.id)).working);
    const replies=(await snapshot(room.id)).messages.filter((m:any)=>m.role==="bot"&&m.kind==="text"&&m.from?.botId===slow.id&&m.turnTerminal);
    expect(replies).toHaveLength(1); expect(replies[0].text).toContain("CORRECTION");
    rmSync(patientFinishGate,{force:true});
    await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow HELD STOP RUN"});
    await wait(async()=>(await snapshot(room.id)).activeBotIds.includes(slow.id));
    // The same bot can own a distinct private task while it is speaking in the room.
    expect((await api("POST",`/api/bots/${slow.id}/messages`,{text:"PRIVATE SIBLING"})).status).toBe(202);
    await wait(async()=>Boolean((await api("GET","/api/bots?messages=0")).body.bots.find((b:any)=>b.id===slow.id)?.tasks?.some((t:any)=>t.busy)));
    const pending=await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow STEERED BEFORE STOP"});
    expect(pending.body.queued).toBe(true);
    expect((await api("POST",`/api/groups/${room.id}/queue/${pending.body.queueId}/steer`,{botId:slow.id})).body.steered).toBe(true);
    expect((await api("POST",`/api/groups/${room.id}/interrupt`,{})).status).toBe(200);
    expect((await api("DELETE",`/api/groups/${room.id}/queue/${pending.body.queueId}`)).status).toBe(404);
    await wait(async()=>!(await snapshot(room.id)).working);
    expect((await api("GET","/api/bots?messages=0")).body.bots.find((b:any)=>b.id===slow.id).busy).toBe(true);
    writeFileSync(patientFinishGate,"release private sibling");
    await wait(async()=>!(await api("GET","/api/bots?messages=0")).body.bots.find((b:any)=>b.id===slow.id).busy);
    const current=await snapshot(room.id);
    expect(current.tasks).toHaveLength(1);
    expect(current.messages.filter((m:any)=>m.kind==="text"&&m.role==="user").map((m:any)=>m.text)).toEqual(["@Slow FIRST","@Quick SECOND","@Slow CORRECTION","@Slow HELD STOP RUN","@Slow STEERED BEFORE STOP"]);
  });
  it("steers a pasted mid-tool message once and reports transport admission without claiming consumption", async () => {
    const slow=await createBot("Slow","patient");
    const other=await createBot("Other","quick");
    const room=(await api("POST","/api/groups",{name:"Paste steer",memberIds:[slow.id,other.id],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    rmSync(patientFinishGate,{force:true});
    await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow START"});
    await wait(async()=>(await snapshot(room.id)).messages.some((m:any)=>m.from?.botId===slow.id&&m.tool?.name==="Bash"));
    const text='@Slow correction\n\n<pasted-text index="1">\nFULL PASTED INPUT\nsecond line\n</pasted-text>';
    const body={text,sendId:"paste-steer-once"};
    const [queued,retry]=await Promise.all([api("POST",`/api/groups/${room.id}/messages`,body),api("POST",`/api/groups/${room.id}/messages`,body)]);
    expect(queued.body.queued).toBe(true);
    expect(retry.body.queueId).toBe(queued.body.queueId);
    const route=`/api/groups/${room.id}/queue/${queued.body.queueId}/steer`;
    const steered=await api("POST",route,{botId:slow.id});
    expect(steered.body).toMatchObject({steered:true});
    expect(steered.body.messages[0].steerDelivery).toBe("transport_written");
    const messages=(await snapshot(room.id)).messages;
    expect(messages.filter((m:any)=>m.text===text)).toHaveLength(1);
    expect(messages.some((m:any)=>m.tool?.name?.includes("consumption is unconfirmed"))).toBe(false);
    expect(messages.some((m:any)=>m.role==="bot"&&m.turnTerminal)).toBe(false);
    expect((await api("POST",route,{botId:slow.id})).status).toBe(404);
    writeFileSync(patientFinishGate,"finish");
    await wait(async()=>!(await snapshot(room.id)).working);
    const replies=(await snapshot(room.id)).messages.filter((m:any)=>m.role==="bot"&&m.kind==="text"&&m.turnTerminal&&m.from?.botId===slow.id);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toContain("FULL PASTED INPUT\nsecond line");
  });

  it("steers an addressed room message only into the addressed busy member", async () => {
    const slow=await createBot("Slow","patient");
    const other=await createBot("Other","patient");
    const room=(await api("POST","/api/groups",{name:"Recipient steer",memberIds:[slow.id,other.id],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    rmSync(patientFinishGate,{force:true});
    await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow @Other start"});
    await wait(async()=>(await snapshot(room.id)).activeBotIds?.length===2);
    const sent=await api("POST",`/api/groups/${room.id}/messages`,{text:"@Other private correction"});
    expect(sent.body.queued).toBe(true);
    expect((await api("POST",`/api/groups/${room.id}/queue/${sent.body.queueId}/steer`,{botId:other.id})).body.steered).toBe(true);
    // Slow was never offered it: only Other's runtime received the words.
    const aliases=JSON.parse(readFileSync(join(home,".openmausbot","room-runtime-aliases.json"),"utf8"));
    const runtimeFor=(botId:string)=>aliases.find(([,owner]:[string,{threadId:string;botId:string}])=>owner.threadId===room.threadId&&owner.botId===botId)?.[0];
    const native=(botId:string)=>readFileSync(join(home,".openmausbot","native",`${runtimeFor(botId)}.ndjson`),"utf8");
    expect(native(other.id)).toContain("private correction");
    expect(native(slow.id)).not.toContain("private correction");
    expect((await snapshot(room.id)).messages.filter((m:any)=>m.text==="@Other private correction")).toHaveLength(1);
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });

  it("queues a mixed send until the active round ends, then dispatches each addressee once", async () => {
    const slow=await createBot("Slow","held");
    const quick=await createBot("Quick","quick");
    const bystander=await createBot("Bystander","held");
    const room=(await api("POST","/api/groups",{name:"Mixed queue",memberIds:[slow.id,quick.id,bystander.id],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    writeFileSync(patientFinishGate,"hold active members");
    await api("POST",`/api/groups/${room.id}/messages`,{text:"@Slow @Bystander start"});
    await wait(async()=>(await snapshot(room.id)).activeBotIds?.length===2);
    const text="@Slow @Quick MIXEDTOKEN";
    const [sent,retry]=await Promise.all([api("POST",`/api/groups/${room.id}/messages`,{text,sendId:"mixed-send-once-0001"}),api("POST",`/api/groups/${room.id}/messages`,{text,sendId:"mixed-send-once-0001"})]);
    expect(sent.body).toMatchObject({ok:true,queued:true});
    expect(retry.body.queueId).toBe(sent.body.queueId);
    const held=await snapshot(room.id);
    expect(held.messages.some((m:any)=>m.role==="user"&&m.text===text)).toBe(false);
    expect(held.activeBotIds).toEqual(expect.arrayContaining([slow.id,bystander.id]));
    expect(held.activeBotIds).not.toContain(quick.id);
    rmSync(patientFinishGate,{force:true});
    await wait(async()=>!(await snapshot(room.id)).working);
    const done=(await snapshot(room.id)).messages;
    expect(done.filter((m:any)=>m.role==="user"&&m.text===text&&m.queueId===sent.body.queueId)).toHaveLength(1);
    const replies=(id:string)=>done.filter((m:any)=>m.role==="bot"&&m.kind==="text"&&m.turnTerminal&&m.from?.botId===id);
    expect(replies(slow.id)).toHaveLength(2);
    expect(replies(quick.id)).toHaveLength(1);
    expect(replies(bystander.id)).toHaveLength(1);
    expect((await api("DELETE",`/api/groups/${room.id}/queue/${sent.body.queueId}`)).status).toBe(404);
  });

  it("queues multiple busy and mixed addressees in order without dispatching a bystander", async () => {
    const slow=await createBot("SlowA","held");
    const slow2=await createBot("SlowB","held");
    const quick=await createBot("QuickC","quick");
    const bystander=await createBot("BystanderD","held");
    const room=(await api("POST","/api/groups",{name:"Multi busy queue",memberIds:[slow.id,slow2.id,quick.id,bystander.id],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    writeFileSync(patientFinishGate,"hold active members");
    await api("POST",`/api/groups/${room.id}/messages`,{text:"@SlowA @SlowB @BystanderD start"});
    await wait(async()=>(await snapshot(room.id)).activeBotIds?.length===3);
    const allBusy=await api("POST",`/api/groups/${room.id}/messages`,{text:"@SlowA @SlowB BOTHBUSY",sendId:"multi-busy-send-0001"});
    const mixed=await api("POST",`/api/groups/${room.id}/messages`,{text:"@SlowA @SlowB @QuickC MULTIMIX",sendId:"multi-busy-send-0002"});
    expect(allBusy.body).toMatchObject({ok:true,queued:true});
    expect(mixed.body).toMatchObject({ok:true,queued:true});
    const held=await snapshot(room.id);
    expect(held.messages.filter((m:any)=>m.role==="user")).toHaveLength(1);
    expect(held.activeBotIds).not.toContain(quick.id);
    const chips=(await api("GET","/api/bots?messages=0")).body.botQueuedMessages[room.threadId];
    expect(chips.map((item:any)=>item.queueId)).toEqual([allBusy.body.queueId,mixed.body.queueId]);
    rmSync(patientFinishGate,{force:true});
    await wait(async()=>!(await snapshot(room.id)).working);
    const done=(await snapshot(room.id)).messages;
    expect(done.filter((m:any)=>m.role==="user").map((m:any)=>m.text)).toEqual(["@SlowA @SlowB @BystanderD start","@SlowA @SlowB BOTHBUSY","@SlowA @SlowB @QuickC MULTIMIX"]);
    const replies=(id:string)=>done.filter((m:any)=>m.role==="bot"&&m.kind==="text"&&m.turnTerminal&&m.from?.botId===id);
    expect(replies(slow.id)).toHaveLength(3);
    expect(replies(slow2.id)).toHaveLength(3);
    expect(replies(quick.id)).toHaveLength(1);
    expect(replies(bystander.id)).toHaveLength(1);
    for(const queued of [allBusy,mixed]) expect((await api("DELETE",`/api/groups/${room.id}/queue/${queued.body.queueId}`)).status).toBe(404);
  });

  it("keeps duplicate provider approval ids in exact lanes and rejects a stale token on the next turn", async () => {
    const a=await createBot("ApproveA","approvalA"); const b=await createBot("ApproveB","approvalB");
    expect((await api("PATCH",`/api/bots/${a.id}`,{approvalMode:"ask"})).status).toBe(200); expect((await api("PATCH",`/api/bots/${b.id}`,{approvalMode:"ask"})).status).toBe(200);
    const room=(await api("POST","/api/groups",{name:"Approvals",memberIds:[a.id,b.id],setup:{bulletin:"",defaultResponder:{kind:"everyone"}}})).body.group;
    let runtimeA=""; let runtimeB="";
    const ready=await openSse(`${base}/api/events`);
    try {
      expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"Start both"})).status).toBe(202);
      runtimeA=(await ready.until(frame=>frame.kind==="runtime"&&frame.event.type==="turn.started"&&frame.event.roomBotId===a.id)).event.roomRuntimeThreadId;
      runtimeB=(await ready.until(frame=>frame.kind==="runtime"&&frame.event.type==="turn.started"&&frame.event.roomBotId===b.id)).event.roomRuntimeThreadId;
    } finally { ready.close(); }
    const approvalEvents=await openSse(`${base}/api/events`);
    const answersA=await askPermission(runtimeA,"duplicate-provider-id"); const answersB=await askPermission(runtimeB,"duplicate-provider-id");
    try {
      await wait(async()=>{ const current=await snapshot(room.id); const cards=current.messages.filter((m:any)=>m.card?.requestId&&!m.card.answered); if(answersA.length||answersB.length) throw new Error("provider answered before the person chose"); return cards.length===2; },"simultaneous approval cards");
      const notification=await approvalEvents.until(frame=>frame.kind==="notify"&&frame.notification.kind==="approval"&&frame.notification.botId===a.id);
      expect(notification.notification.threadId).toBe(room.threadId);
    } finally { approvalEvents.close(); }
    let cards=(await snapshot(room.id)).messages.filter((m:any)=>m.card?.requestId&&!m.card.answered);
    const cardA=cards.find((m:any)=>m.from.botId===a.id); const cardB=cards.find((m:any)=>m.from.botId===b.id);
    expect(cardA.card.requestId).not.toBe(cardB.card.requestId);
    expect((await api("POST",`/api/threads/${room.threadId}/respond`,{requestId:cardA.card.requestId,behavior:"allow"})).body.outcome).toBe("allowed-once");
    await wait(async()=>answersA.length===1); expect(answersB).toHaveLength(0);
    expect((await snapshot(room.id)).messages.find((m:any)=>m.id===cardB.id).card.answered).toBeUndefined();
    await api("POST",`/api/groups/${room.id}/interrupt`,{botId:a.id});
    await wait(async()=>!(await snapshot(room.id)).activeBotIds.includes(a.id),"targeted lane stop");
    rmSync(join(home,"approval-dumps",`${runtimeA}.json`),{force:true});
    const nextReady=await openSse(`${base}/api/events`);
    try {
      expect((await api("POST",`/api/groups/${room.id}/messages`,{text:"@ApproveA next turn"})).status).toBe(202);
      await nextReady.until(frame=>frame.kind==="runtime"&&frame.event.type==="turn.started"&&frame.event.roomBotId===a.id);
    } finally { nextReady.close(); }
    const nextAnswers=await askPermission(runtimeA,"duplicate-provider-id");
    await wait(async()=>(await snapshot(room.id)).messages.some((m:any)=>m.from?.botId===a.id&&m.card?.requestId&&m.card.requestId!==cardA.card.requestId&&!m.card.answered),"new generation approval card");
    cards=(await snapshot(room.id)).messages.filter((m:any)=>m.from?.botId===a.id&&m.card?.requestId&&!m.card.answered);
    const nextCard=cards.at(-1);
    expect((await api("POST",`/api/threads/${room.threadId}/respond`,{requestId:cardA.card.requestId,behavior:"allow"})).body.outcome).toBe("unavailable");
    expect(nextAnswers).toHaveLength(0);
    expect((await api("POST",`/api/threads/${room.threadId}/respond`,{requestId:nextCard.card.requestId,behavior:"deny"})).body.outcome).toBe("rejected");
    await wait(async()=>nextAnswers.length===1);
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });
  it("routes simultaneous questions to their own provider and refuses ambiguous steering without consuming the queue", async () => {
    const a=await createBot("AskA","questionA"); const b=await createBot("AskB","questionB");
    const room=(await api("POST","/api/groups",{name:"Questions",memberIds:[a.id,b.id],setup:{bulletin:"",defaultResponder:{kind:"everyone"}}})).body.group;
    await api("POST",`/api/groups/${room.id}/messages`,{text:"Start both questions"});
    await wait(async()=>(await snapshot(room.id)).messages.filter((m:any)=>m.card?.title==="Your bot has a question"&&!m.card.answered).length===2);
    const cards=(await snapshot(room.id)).messages.filter((m:any)=>m.card?.title==="Your bot has a question"&&!m.card.answered);
    expect((await api("POST",`/api/threads/${room.threadId}/respond`,{requestId:cards[0].card.requestId,behavior:"answer",message:"Yes"})).body.outcome).toBe("answered");
    expect((await snapshot(room.id)).messages.find((m:any)=>m.id===cards[1].id).card.answered).toBeUndefined();
    const queued=await api("POST",`/api/groups/${room.id}/messages`,{text:"unclear correction"});
    expect(queued.body.queued).toBe(true);
    expect((await api("POST",`/api/groups/${room.id}/queue/${queued.body.queueId}/steer`,{})).status).toBe(409);
    expect((await api("DELETE",`/api/groups/${room.id}/queue/${queued.body.queueId}`)).status).toBe(200);
    await api("POST",`/api/groups/${room.id}/interrupt`,{});
  });
  it("wakes a mentioned bot after the fourth consecutive bot reply", async () => {
    const members = [];
    for (const letter of ["A", "B", "C", "D", "E"]) members.push(await createBot(`Chain${letter}`, `chain${letter}`));
    const room = (await api("POST", "/api/groups", { name: "Uncapped handoff", memberIds: members.map(bot => bot.id), setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@ChainA start" })).status).toBe(202);
    await wait(async () => !(await snapshot(room.id)).working);
    const messages = (await snapshot(room.id)).messages;
    expect(messages.filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.from.botId)).toEqual(members.map(bot => bot.id));
    expect(messages.some((m: any) => m.tool?.name?.startsWith("paused after "))).toBe(false);
  });
  it("delivers a lead callback after three consecutive bot replies", async () => {
    const a = await createBot("ChainA", "chainA");
    const b = await createBot("ChainB", "chainB");
    const c = await createBot("ChainC", "callbackC");
    const room = (await api("POST", "/api/groups", { name: "Lead callback", memberIds: [a.id, b.id, c.id], setup: { bulletin: "", defaultResponder: { kind: "mentions" } } })).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, { text: "@ChainA start" })).status).toBe(202);
    await wait(async () => !(await snapshot(room.id)).working);
    const messages = (await snapshot(room.id)).messages;
    expect(messages.filter((m: any) => m.role === "bot" && m.kind === "text").map((m: any) => m.from.botId)).toEqual([a.id, b.id, c.id, a.id]);
    expect(messages.some((m: any) => m.tool?.name?.startsWith("paused after "))).toBe(false);
  });
  it("delivers the second lead callback after reviewer and builder results", async () => {
    const director = await createBot("Director", "director");
    const reviewer = await createBot("Reviewer", "reviewer");
    const builder = await createBot("Builder", "builder");
    const room = (await api("POST", "/api/groups", {name:"Sequential results",memberIds:[director.id,reviewer.id,builder.id],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    await api("POST", `/api/groups/${room.id}/messages`, {text:"@Director start"});
    await wait(async()=>!(await snapshot(room.id)).working);
    const messages=(await snapshot(room.id)).messages;
    expect(messages.filter((m:any)=>m.role==="bot"&&m.kind==="text"&&m.turnTerminal).map((m:any)=>m.from.botId)).toEqual([director.id,reviewer.id,director.id,builder.id,director.id]);
    expect(messages.filter((m:any)=>m.text==="REVIEWED FINAL RESULT")).toHaveLength(1);
  });

  it("runs five mentioned workers concurrently and returns each result callback exactly once", async () => {
    const lead=await createBot("Lead","parallelLead");
    const workers=[];
    for(let i=1;i<=5;i++) workers.push(await createBot(`Worker${i}`,`worker${i}`));
    const room=(await api("POST","/api/groups",{name:"Five concurrent workers",memberIds:[lead.id,...workers.map(b=>b.id)],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    const gate=join(home,"workers-tool.gate");
    writeFileSync(gate,"hold workers mid tool call");
    try {
      await api("POST",`/api/groups/${room.id}/messages`,{text:"@Lead start"});
      await expect.poll(async()=>new Set((await snapshot(room.id)).activeBotIds),{timeout:6000}).toEqual(new Set(workers.map(b=>b.id)));
    } finally { rmSync(gate,{force:true}); }
    await wait(async()=>!(await snapshot(room.id)).working);
    const messages=(await snapshot(room.id)).messages;
    for(let i=1;i<=5;i++) {
      expect(messages.filter((m:any)=>m.text===`@Lead RESULT ${i}`)).toHaveLength(1);
      expect(messages.filter((m:any)=>m.text===`REVIEWED RESULT ${i}`)).toHaveLength(1);
    }
  });

  it("deduplicates reciprocal source-content routes even when both members are always responders", async () => {
    const a=await createBot("LoopA","loopA"); const b=await createBot("LoopB","loopB");
    const room=(await api("POST","/api/groups",{name:"Loop brake",memberIds:[a.id,b.id],setup:{bulletin:"",defaultResponder:{kind:"mentions"}}})).body.group;
    await api("PATCH",`/api/groups/${room.id}`,{memberReplyModes:{[a.id]:"always",[b.id]:"always"}});
    await api("POST",`/api/groups/${room.id}/messages`,{text:"@LoopA start"});
    await wait(async()=>!(await snapshot(room.id)).working);
    const messages=(await snapshot(room.id)).messages;
    // Each source-content route runs once; a repeated route cannot ping-pong.
    const speakers=messages.filter((m:any)=>m.role==="bot"&&m.kind==="text").map((m:any)=>m.from.botId);
    expect(speakers).toHaveLength(4);
    expect(new Set(speakers)).toEqual(new Set([a.id,b.id]));
  });
  it("publishes canonical room events with distinct member lane attribution", async () => {
    const a=await createBot("StreamA","quick"); const b=await createBot("StreamB","quick");
    const room=(await api("POST","/api/groups",{name:"Lane events",memberIds:[a.id,b.id],setup:{bulletin:"",defaultResponder:{kind:"everyone"}}})).body.group;
    const stream=await openSse(`${base}/api/events`);
    try {
      await api("POST",`/api/groups/${room.id}/messages`,{text:"Start two lanes"});
      const first=await stream.until(frame=>frame.kind==="runtime"&&frame.event.type==="content.delta"&&frame.event.roomBotId===a.id);
      const second=await stream.until(frame=>frame.kind==="runtime"&&frame.event.type==="content.delta"&&frame.event.roomBotId===b.id);
      expect(first.event.threadId).toBe(room.threadId);expect(second.event.threadId).toBe(room.threadId);
      expect(first.event.roomRuntimeThreadId).not.toBe(second.event.roomRuntimeThreadId);
      await api("POST",`/api/groups/${room.id}/interrupt`,{});
    } finally {stream.close();}
  });

  it("restores room execution ownership after a crash without replaying the held user turn", async () => {
    const bot=await createBot("Restart owner","patient");
    const room=(await api("POST","/api/groups",{name:"Recovery",memberIds:[bot.id],setup:{bulletin:"",defaultResponder:{kind:"member",botId:bot.id}}})).body.group;
    rmSync(patientFinishGate,{force:true});
    const stream=await openSse(`${base}/api/events`);
    let runtimeId:string;
    try {
      await api("POST",`/api/groups/${room.id}/messages`,{text:"HELD BEFORE CRASH"});
      const started=await stream.until(frame=>frame.kind==="runtime"&&frame.event.type==="turn.started"&&frame.event.roomBotId===bot.id);
      runtimeId=started.event.roomRuntimeThreadId;
    } finally { stream.close(); }
    child.kill("SIGKILL");
    writeFileSync(patientFinishGate,"let the orphaned fake exit");
    await waitForExit(child);
    const port=Number(new URL(base).port);
    child=spawn(process.execPath,[join(SERVER_DIR,"index.ts")],{cwd:ROOT,env:{
      ...(process.env.PATH ? {PATH:process.env.PATH} : {}),
      ...(process.env.SystemRoot ? {SystemRoot:process.env.SystemRoot} : {}),
      HOME:home,USERPROFILE:home,OMB_PORT:String(port),OMB_WEBHOOK_PORT:String(port+1),OMB_STATIC_DIR:join(home,"static"),OMB_TEST_INTERNAL_CAPABILITY_KEY:TEST_CAPABILITY_KEY,
    },stdio:["ignore","pipe","pipe"]});
    child.stderr!.on("data",chunk=>stderr+=chunk);
    await wait(async()=>{try{return(await fetch(`${base}/api/health`)).status===200;}catch{return false;}});
    const recovered=await snapshot(room.id);
    expect(recovered.tasks).toHaveLength(1);
    expect(recovered.activeBotIds).toEqual([]);
    const receipt=recovered.messages.find((message:any)=>message.tool?.recovery)?.tool.recovery;
    expect(receipt).toMatchObject({botId:bot.id,threadId:room.threadId});
    const aliases=JSON.parse(readFileSync(join(home,".openmausbot","room-runtime-aliases.json"),"utf8"));
    expect(aliases.find(([id]:[string,unknown])=>id===runtimeId)?.[1]).toMatchObject({threadId:room.threadId,botId:bot.id});
    expect(recovered.messages.filter((m:any)=>m.kind==="text"&&m.role==="user").map((m:any)=>m.text)).toEqual(["HELD BEFORE CRASH"]);
    expect(recovered.messages.some((m:any)=>m.kind==="text"&&m.role==="bot"&&m.text?.includes("reply to:"))).toBe(false);
    const reviewed=await api("POST",`/api/bots/${bot.id}/threads/${room.threadId}/recovery/${receipt.id}/review`,{confirmed:true});
    expect(reviewed.status).toBe(200);expect(reviewed.body.receipt.threadId).toBe(room.threadId);
  });

});
