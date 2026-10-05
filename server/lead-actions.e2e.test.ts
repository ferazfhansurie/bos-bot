import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { handleToolCall, request } from "../scripts/mcp-server.ts";
it("tagged blocked report persists after chat, clear and reload; evidence resolves it", async () => {
 const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
 const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
 const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
 try {
  const lead = (await cli("new-bot", "--name", "bos")).bot; const worker = (await cli("new-bot", "--name", "worker")).bot;
  const created: any = await handleToolCall("create_channel", { name: "fixture", member_ids: [lead.id, worker.id] }, (p, o) => request(p, o, session.info.url));
  const room = created.channel;
  writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({ [worker.id]: { reply: "blocked @bos: free fixture disk then verify installer" }, [lead.id]: { reply: "i replied" } }));
  await cli("send-channel", "--channel", room.id, "--text", "@worker report"); await cli("wait", "--channel", room.id, "--timeout", "30");
  let actions = (await api("/api/lead-actions")).actions; expect(actions).toHaveLength(1); const action = actions[0]; expect(action.status).toBe("blocked");
  expect(action.reporterBotId).toBe(worker.id); expect(action.runId).toBeTruthy();
  const evidence = readFileSync(join(session.info.dataDir, "room-plan.json.evidence.jsonl"), "utf8");
  expect(evidence).toContain("resolve_lead_action");
  const inbox = await api("/api/inbox"); expect(inbox.items.find((i: any) => i.leadAction?.id === action.id)?.preview).toContain("blocked");
  await api("/api/inbox/clear", {});
  await cli("send-channel", "--channel", room.id, "--text", "@bos acknowledge"); await cli("wait", "--channel", room.id, "--timeout", "30");
  actions = (await api("/api/lead-actions")).actions; expect(actions[0].status).toBe("blocked");
  expect(JSON.parse(readFileSync(join(session.info.dataDir, "lead-actions.json"), "utf8"))[0].messageId).toBe(action.messageId);
  await expect(api(`/api/lead-actions/${action.id}/resolve`, { decision: "replied", evidence: "", expectedUpdatedAt: action.updatedAt })).rejects.toThrow();
  await api(`/api/lead-actions/${action.id}/resolve`, { decision: "freed fixture disk", evidence: "isolated installer check passed", expectedUpdatedAt: action.updatedAt });
  expect((await api("/api/lead-actions")).actions[0].status).toBe("resolved");
  expect((await api(`/api/threads/${room.activeTaskId}/messages`)).messages.find((m: any) => m.id === action.messageId).leadAction.resolution.evidence).toBe("isolated installer check passed");
 } finally { await session.close(); }
}, 60_000);
it("explicit report tools deduplicate and only the accountable room lead resolves; revoked devices and membership are denied", async () => {
 const session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
 const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
 const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
 try {
  const lead = (await cli("new-bot", "--name", "lead")).bot; const worker = (await cli("new-bot", "--name", "worker")).bot;
  const created: any = await handleToolCall("create_channel", { name: "tools fixture", member_ids: [lead.id, worker.id] }, (p, o) => request(p, o, session.info.url));
  const room = created.channel; const planFile = join(session.info.dataDir, "room-plan.json");
  const report = { tool: "report_lead_action", arguments: { lead_bot_id: lead.id, kind: "completion", required_action: "verify fixture", report: "fixture artifact ready", request_key: "fixture" } };
  writeFileSync(planFile, JSON.stringify({ [worker.id]: { steps: [report, report], reply: "waiting for verification" } }));
  await cli("send-channel", "--channel", room.id, "--text", "@worker report"); await cli("wait", "--channel", room.id, "--timeout", "30");
  const actions = (await api("/api/lead-actions")).actions; expect(actions).toHaveLength(1); const action = actions[0];
  const resolve = { tool: "resolve_lead_action", arguments: { id: action.id, decision: "checked fixture", evidence: "isolated boundary fixture passed", expected_updated_at: action.updatedAt } };
  writeFileSync(planFile, JSON.stringify({ [worker.id]: { steps: [{ ...resolve, expectError: true }], reply: "cannot decide for lead" }, [lead.id]: { steps: [{ tool: "list_lead_actions", arguments: {} }, resolve], reply: "verified" } }));
  await cli("send-channel", "--channel", room.id, "--text", "@worker resolve"); await cli("wait", "--channel", room.id, "--timeout", "30");
  expect((await api("/api/lead-actions")).actions[0].status).toBe("pending");
  await cli("send-channel", "--channel", room.id, "--text", "@lead verify"); await cli("wait", "--channel", room.id, "--timeout", "30");
  expect((await api("/api/lead-actions")).actions[0].resolution.by).toBe(lead.id);
  const pairing = await api("/api/auth/pairing", { scopes: ["client"] });
  const paired = await api("/api/auth/pair", { code: pairing.code, label: "fixture device" });
  const device = (p: string, body?: unknown) => fetch(`${session.info.url}${p}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${paired.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  expect((await device("/api/lead-actions")).status).toBe(200);
  await api(`/api/auth/sessions/${paired.session.id}`, {}, "DELETE");
  expect((await device("/api/lead-actions")).status).toBe(401);
  expect((await device(`/api/lead-actions/${action.id}/resolve`, { decision: "change", evidence: "new", expectedUpdatedAt: action.updatedAt })).status).toBe(401);
  await api(`/api/groups/${room.id}`, { memberIds: [worker.id] }, "PATCH");
  expect((await api("/api/lead-actions")).actions).toHaveLength(0);
  expect((await fetch(`${session.info.url}/api/lead-actions/${action.id}/resolve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "change", evidence: "new", expectedUpdatedAt: action.updatedAt }) })).status).toBe(403);
 } finally { await session.close(); }
}, 60_000);
