import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
it("owner edits retain queue identity; stale/thread/revoked/drained/cancelled refuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "omb-queue-edit-"));
  const gate = join(root, "finish");
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000) });
    const result = { status: response.status, body: await response.json() as any };
    if (!path.startsWith("/api/auth")) evidence.push({method,path,body,result});
    return result;
  };
  try {
    const model = (await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "claude").models.options[0].id;
    const bot = (await api("POST", "/api/bots", {name:"Queue edit fixture",modelSelection:{instanceId:"claude",model}})).body.bot;
    const other = (await api("POST", "/api/bots", {name:"Other",modelSelection:{instanceId:"claude",model}})).body.bot;
    const messages = `/api/bots/${bot.id}/messages`;
    expect((await api("POST", messages, {threadId:bot.threadId,text:"hold"})).status).toBe(202);
    const queued = (await api("POST", messages, {threadId:bot.threadId,text:"old",sendId:"fixture_queue_edit_send_1"})).body;
    expect(queued.queued).toBe(true);
    const route = `/api/bots/${bot.id}/queue/${queued.queueId}`;
    const body = {threadId:bot.threadId,expectedText:"old",text:"new"};
    expect((await api("PATCH", `/api/bots/${other.id}/queue/${queued.queueId}`, {...body,threadId:other.threadId})).status).toBe(409);
    expect((await api("PATCH", route, {...body,threadId:other.threadId})).status).toBeGreaterThanOrEqual(400);
    const pairing = (await api("POST", "/api/auth/pairing", {scopes:["client"]})).body;
    const paired = (await api("POST", "/api/auth/pair", {code:pairing.code,label:"queue fixture"})).body;
    expect(typeof paired.token).toBe("string");
    expect((await api("PATCH", route, body, paired.token)).body).toEqual({ok:true,queueId:queued.queueId,threadId:bot.threadId,text:"new"});
    expect((await api("PATCH", route, body, paired.token)).status).toBe(200);
    expect((await api("PATCH", route, {...body,text:"stale overwrite"}, paired.token)).status).toBe(409);
    // Headers are authorized before the body completes; revocation must be
    // checked again at the actual edit, not only on initial authentication.
    const raw = JSON.stringify({...body, expectedText:"new", text:"late revoked edit"});
    const held = request(`${fixture.info.url}${route}`, {method:"PATCH",headers:{
      "content-type":"application/json","content-length":Buffer.byteLength(raw),expect:"100-continue",authorization:`Bearer ${paired.token}` }});
    const accepted = new Promise<void>(resolve => held.once("continue", resolve));
    const answer = new Promise<{status:number;body:any}>((resolve,reject) => {
      held.on("error",reject); held.on("response",res => {
        let data=""; res.setEncoding("utf8"); res.on("data",chunk => data+=chunk);
        res.on("end",() => resolve({status:res.statusCode!,body:JSON.parse(data)}));
      });
    });
    held.flushHeaders(); await accepted;
    expect((await api("DELETE", `/api/auth/sessions/${paired.session.id}`)).status).toBe(200);
    held.end(raw); expect((await answer).status).toBe(401);
    evidence.push({check:"revoked while body held",status:401});
    expect((await api("PATCH", route, { ...body, expectedText:"new", text:"revoked" }, paired.token)).status).toBe(401);
    const cancel = (await api("POST", messages, {threadId:bot.threadId,text:"cancel"})).body;
    expect((await api("DELETE", `/api/bots/${bot.id}/queue/${cancel.queueId}`, {threadId:bot.threadId})).status).toBe(200);
    expect((await api("PATCH", `/api/bots/${bot.id}/queue/${cancel.queueId}`, {...body,expectedText:"cancel"})).status).toBe(409);
    const room = (await api("POST", "/api/groups", {name:"Queued room",memberIds:[other.id],setup:{bulletin:"Fixture only.",defaultResponder:{kind:"member",botId:other.id}}})).body.group;
    expect((await api("POST", `/api/groups/${room.id}/messages`, {text:"hold room",threadId:room.threadId})).status).toBe(202);
    const roomQueue = (await api("POST", `/api/groups/${room.id}/messages`, {text:"old room",threadId:room.threadId})).body;
    expect(roomQueue.queued).toBe(true);
    const roomRoute = `/api/groups/${room.id}/queue/${roomQueue.queueId}`;
    expect((await api("PATCH", roomRoute, {threadId:room.threadId,expectedText:"old room",text:"new room"})).status).toBe(200);
    expect((await api("PATCH", roomRoute, {threadId:bot.threadId,expectedText:"new room",text:"wrong thread"})).status).toBe(409);
    expect((await api("DELETE", roomRoute)).status).toBe(200);
    writeFileSync(gate,"finish");
    await expect.poll(async () => {
      const rows = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
      return rows.find((m:any) => m.queueId === queued.queueId)?.text;
    }, {timeout:15000}).toBe("new");
    expect((await api("PATCH", route, body)).status).toBe(409);
    const rows = (await api("GET", `/api/threads/${bot.threadId}/messages?limit=50`)).body.messages;
    expect(rows.filter((m:any) => m.queueId === queued.queueId && m.role === "user")).toHaveLength(1);
  } finally {
    const evidencePath = `${fixture.info.logPath}.queue-edit.json`;
    writeFileSync(evidencePath,JSON.stringify({fixture:fixture.info,evidence},null,2));
    console.info(JSON.stringify({evidencePath}));
    await fixture.close(); rmSync(root,{recursive:true,force:true});
  }
}, 40000);
