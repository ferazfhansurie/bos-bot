import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";

test("two real isolated homes forward Chief tools and resume once for coordination and owner-reviewed setup", async () => {
  const gates = mkdtempSync(join(tmpdir(), "chief-routing-"));
  const gate = join(gates, "finish");
  const remote = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(["remote bounded result"]) });
  let local: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
  let restarted: ChildProcess | undefined;
  const api = async (fixture: typeof remote, method: string, path: string, body?: unknown, token?: string, expected = 200) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
      ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any; expect(response.status, JSON.stringify(result)).toBe(expected); return result;
  };
  try {
    const pairing = await api(remote, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api(remote, "POST", "/api/auth/pair", { code: pairing.code });
    const remoteHome = (await api(remote, "GET", "/.well-known/openmausbot/environment")).environmentId;
    const localHome = randomUUID();
    local = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, undefined, undefined, undefined, undefined, undefined, [], undefined, {
      origin: remote.info.url, prepare: dataDir => {
        writeFileSync(join(dataDir, "environment-id"), localHome);
        writeFileSync(join(dataDir, "multiplayer-links.json"), JSON.stringify({ version: 1, links: [{ homeId: remoteHome, name: "partner", origin: "https://delegated-fixture.example.ts.net:8443", token: paired.token, bots: [], proxyGroups: {} }] }));
      },
    });
    const chief = (await api(local, "GET", "/api/bots")).bots[0];
    await api(local, "PATCH", `/api/bots/${chief.id}`, { chiefOfStaff: true });
    const target = (await api(remote, "GET", "/api/bots")).bots[0];
    await api(remote, "POST", "/api/bots", { name: "Surviving receipt owner", title: "Fixture", modelSelection: target.modelSelection }, undefined, 201);
    const grant = { granteeHomeId: localHome, granteeBotId: chief.id, peerSessionId: paired.session.id, peerTokenHash: createHash("sha256").update(paired.token).digest("hex"),
      scopes: ["coordinate", "bots:create", "bots:delete", "bots:configure"], section: "", autoApply: false, note: "two-home fixture" };
    const grantFile = join(remote.info.dataDir, "cross-home-grants.json");
    const setGrant = (entries: any[]) => writeFileSync(grantFile, JSON.stringify({ version: 1, delegations: entries }));
    let previousPid = 0;
    const begin = async () => {
      if (existsSync(gate)) unlinkSync(gate);
      await runControlOmb(["send", "--bot", chief.id, "--task", chief.threadId, "--text", "bounded remote fixture work", "--url", local!.info.url]);
      await expect.poll(() => existsSync(local!.fixtureDumpPath) && JSON.parse(readFileSync(local!.fixtureDumpPath, "utf8")).pid !== previousPid, { timeout: 15000 }).toBe(true);
      const dump = JSON.parse(readFileSync(local!.fixtureDumpPath, "utf8")); previousPid = dump.pid;
      return dump.mcpConfig.mcpServers.agents.env.OMB_COMMS_TOKEN;
    };
    let capability = await begin();
    expect((await api(local, "GET", "/api/internal/agents", undefined, capability)).bots.some((bot: any) => bot.id.startsWith("rb-"))).toBe(false);
    setGrant([{ ...grant, granteeBotId: "wrong-bot" }]);
    expect((await api(local, "GET", "/api/internal/room-targets", undefined, capability)).bots.some((bot: any) => bot.id.startsWith("rb-"))).toBe(false);
    setGrant([grant]);
    const roster = await api(local, "GET", "/api/internal/agents", undefined, capability);
    const delegated = roster.bots.find((bot: any) => bot.home === remoteHome && bot.id.endsWith(`-${target.id}`));
    expect(delegated).toBeDefined(); expect(delegated.section).toBe("partner");
    const coordinated = await api(local, "POST", "/api/internal/coordinate-bots", { botIds: [delegated.id], requestKey: "probe", message: "bounded fixture" }, capability);
    expect(coordinated.accepted).toHaveLength(1);
    writeFileSync(gate, "finish");
    const handoffs = () => JSON.parse(readFileSync(join(local!.info.dataDir, "room-handoffs.json"), "utf8"));
    await expect.poll(() => handoffs().find((node: any) => node.id === coordinated.accepted[0].requestId)?.status, { timeout: 30000 }).toBe("completed");
    await expect.poll(() => handoffs().find((node: any) => !node.parentId)?.status, { timeout: 30000 }).toBe("completed");
    expect(handoffs().find((node: any) => !node.parentId).executions).toBe(2);
    expect(handoffs().find((node: any) => node.id === coordinated.accepted[0].requestId).result).toContain("remote bounded result");
    await expect.poll(async () => !(await api(local!, "GET", "/api/bots")).bots.find((bot: any) => bot.id === chief.id).busy, { timeout: 15000 }).toBe(true);
    previousPid = JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).pid;
    capability = await begin();
    const catalog = await api(local, "GET", `/api/internal/team-setup-catalog?home=${remoteHome}`, undefined, capability);
    expect(catalog.home).toBe(remoteHome);
    const proposal = await api(local, "POST", "/api/internal/team-setup-requests", { home: remoteHome, plan: { reason: "two-home review", operations: [{ action: "update", botId: target.id, fields: { title: "Reviewed remote lead" } }] } }, capability, 201);
    expect(proposal.state).toBe("pending");
    const remoteReviews = async () => (await api(remote, "GET", "/api/bots")).bots.flatMap((b: any) => b.tasks).filter((t: any) => t.openedBy?.name === "Remote Chief setup review");
    expect(await remoteReviews()).toHaveLength(0);
    expect((await api(remote, "GET", "/api/bots")).bots.find((b: any) => b.id === target.id).title).toBe(target.title);
    writeFileSync(gate, "finish");
    await expect.poll(async () => !(await api(local!, "GET", "/api/bots")).bots.find((b: any) => b.id === chief.id).busy, { timeout: 15000 }).toBe(true);
    const approved = await api(local, "POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    expect(approved.result.state).toBe("pending");
    expect(approved.result.remoteRequestId).toBeTruthy();
    const approvedCard = (await api(local, "GET", `/api/threads/${chief.threadId}/messages`)).messages.find((m:any)=>m.card?.requestId===proposal.requestId).card;
    expect(approvedCard.answered).toBe("allow");
    expect(approvedCard.teamSetupRequest.resumed).not.toBe(true);
    expect((await api(local, "GET", "/api/decisions")).decisions.findLast((d:any)=>d.requestId===proposal.requestId).decision).toBe("user-approved");
    expect((await api(remote, "GET", "/api/bots")).bots.find((b: any) => b.id === target.id).title).toBe(target.title);
    const pendingTask = (await remoteReviews())[0];
    expect(pendingTask).toBeDefined();
    const pendingMessage = (await api(remote, "GET", `/api/threads/${pendingTask.threadId}/messages`)).messages.find((m: any) => m.card?.requestId === approved.result.remoteRequestId);
    expect(pendingMessage.card.teamSetupRequest.result).toBeUndefined();
    const duplicatePending = await api(local, "POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    expect(duplicatePending.result.state).toBe("pending");
    await api(remote, "POST", `/api/threads/${pendingTask.threadId}/respond`, {requestId: approved.result.remoteRequestId, behavior: "allow"});
    await expect.poll(async () => (await api(local!, "GET", `/api/threads/${chief.threadId}/messages`)).messages.find((m: any) => m.card?.requestId === proposal.requestId)?.card.teamSetupRequest.result?.state, {timeout:15000}).toBe("applied");
    const monitor = () => handoffs().find((n: any) => n.delegatedProposalId === approved.result.remoteRequestId);
    await expect.poll(() => monitor()?.status, {timeout:15000}).toBe("completed");
    await expect.poll(() => handoffs().find((n: any) => n.id === monitor()?.parentId)?.status, {timeout:15000}).toBe("completed");
    expect(handoffs().find((n: any) => n.id === monitor()?.parentId).executions).toBe(2);
    expect((await api(remote, "GET", "/api/bots")).bots.find((b: any) => b.id === target.id).title).toBe("Reviewed remote lead");
    expect((await api(remote, "GET", "/api/bots")).bots.find((b: any) => b.id === target.id).chiefOfStaff).toBe(target.chiefOfStaff);
    const countReceipts = async () => {
      let count = 0;
      for (const task of (await api(remote, "GET", "/api/bots")).bots.flatMap((b: any) => b.tasks)) count += (await api(remote, "GET", `/api/threads/${task.threadId}/messages`)).messages.filter((m: any) => m.card?.teamSetupRequest).length;
      return count;
    };
    expect(await countReceipts()).toBe(1);
    await expect.poll(async () => !(await api(local!, "GET", "/api/bots")).bots.find((b: any) => b.id === chief.id).busy, { timeout: 15000 }).toBe(true);
    // Restart the actual source server with the same isolated data and transport.
    const restartSource = async (full = false) => {
      const child = restarted ?? local!.child;
      const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
      if (full) {
        const file = join(local!.info.dataDir, "bots.json"); const bots = JSON.parse(readFileSync(file, "utf8"));
        const saved = bots.find((b: any) => b.id === chief.id); saved.approvalMode = "full"; saved.autoApprove = false;
        for (const task of saved.tasks) { task.approvalMode = "full"; task.autoApprove = false; }
        writeFileSync(file, JSON.stringify(bots));
      }
    const log = openSync(local!.info.logPath, "a", 0o600);
    restarted = spawn(process.execPath, ["--import", join(local!.info.dataDir, "delegated-fixture-transport.mjs"), "--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: process.cwd(), env: verificationServerEnvironment({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate }, local!.info.dataDir, Number(new URL(local!.info.url).port)), stdio: ["ignore", log, log] }); closeSync(log);
    await expect.poll(async () => { try { return (await fetch(local!.info.url + "/api/health")).status; } catch { return 0; } }, { timeout: 20000 }).toBe(200);
    };
    await restartSource();
    await api(local, "POST", `/api/threads/${chief.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    expect(await countReceipts()).toBe(1);
    // Deny and cancel source cards without contacting Partner.
    previousPid = JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).pid;
    for (const cancel of [false, true]) {
      capability = await begin();
      const denied = await api(local, "POST", "/api/internal/bot-deletion-requests", { home: remoteHome, targetBotId: delegated.id, reason: "source deny fixture" }, capability, 201);
      expect(denied.state).toBe("pending");
      writeFileSync(gate, "finish");
      await expect.poll(async () => !(await api(local!, "GET", "/api/bots")).bots.find((b: any) => b.id === chief.id).busy, { timeout: 15000 }).toBe(true);
      if (cancel) await api(local, "PATCH", `/api/bots/${chief.id}`, { title: "Changed before approval" });
      const decision = await api(local, "POST", `/api/threads/${chief.threadId}/respond`, { requestId: denied.requestId, behavior: cancel ? "allow" : "deny" });
      expect(decision.result.state).toBe(cancel ? "cancelled" : "denied");
      expect(await countReceipts()).toBe(1);
      await expect.poll(async () => !(await api(local!, "GET", "/api/bots")).bots.find((b: any) => b.id === chief.id).busy, { timeout: 15000 }).toBe(true);
      previousPid = JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).pid;
    }
    // Partner can deny or invalidate its pending card after source approval.
    for (const cancelled of [false, true]) {
      previousPid = JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).pid;
      capability = await begin();
      const source = await api(local, "POST", "/api/internal/bot-deletion-requests", {home:remoteHome,targetBotId:delegated.id,reason:"pending remote decision fixture"}, capability, 201);
      writeFileSync(gate,"finish");
      await expect.poll(async () => !(await api(local!,"GET","/api/bots")).bots.find((b:any)=>b.id===chief.id).busy,{timeout:15000}).toBe(true);
      const pending = await api(local,"POST",`/api/threads/${chief.threadId}/respond`,{requestId:source.requestId,behavior:"allow"});
      expect(pending.result.state).toBe("pending");
      let task: any, card: any;
      for (const candidate of (await api(remote,"GET","/api/bots")).bots.flatMap((b:any)=>b.tasks)) {
        const messages = (await api(remote,"GET",`/api/threads/${candidate.threadId}/messages`)).messages;
        const found = messages.find((m:any)=>m.card?.requestId===pending.result.remoteRequestId);
        if(found) {task=candidate;card=found;break;}
      }
      expect(card).toBeDefined();
      if(cancelled) await api(remote,"PATCH",`/api/bots/${card.card.teamSetupRequest.botId}`,{title:"Changed pending reviewer"});
      await api(remote,"POST",`/api/threads/${task.threadId}/respond`,{requestId:pending.result.remoteRequestId,behavior:cancelled?"allow":"deny"});
      await expect.poll(async () => (await api(local!,"GET",`/api/threads/${chief.threadId}/messages`)).messages.find((m:any)=>m.card?.requestId===source.requestId)?.card.teamSetupRequest.result?.state,{timeout:15000}).toBe(cancelled?"cancelled":"denied");
      const reviewNode=()=>handoffs().find((n:any)=>n.delegatedProposalId===pending.result.remoteRequestId);
      await expect.poll(()=>handoffs().find((n:any)=>n.id===reviewNode()?.parentId)?.status,{timeout:15000}).toBe("completed");
      expect(handoffs().find((n:any)=>n.id===reviewNode()?.parentId).executions).toBe(2);
      expect((await api(remote,"GET","/api/bots")).bots.some((b:any)=>b.id===target.id)).toBe(true);
    }
    setGrant([{...grant, autoApply: true}]);
    await restartSource(true);
    previousPid = JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).pid;
    capability = await begin();
    const full = await api(local, "POST", "/api/internal/team-setup-requests", { home: remoteHome, plan: { reason: "Full source fixture", operations: [{ action: "update", botId: target.id, fields: { title: "Full remote lead" } }] } }, capability, 201);
    expect(full.state).toBe("applied"); expect(await countReceipts()).toBe(4);
    const deleted = await api(local, "POST", "/api/internal/bot-deletion-requests", { home: remoteHome, targetBotId: delegated.id, reason: "Full source delete fixture" }, capability, 201);
    expect(deleted.state, JSON.stringify(deleted)).toBe("applied");
    expect((await api(remote, "GET", "/api/bots")).bots.some((b: any) => b.id === target.id)).toBe(false);
    writeFileSync(gate, "finish");
  } finally { if (restarted && restarted.exitCode === null && restarted.signalCode === null) { const done = once(restarted, "exit"); restarted.kill("SIGTERM"); await done; } await local?.close(); await remote.close(); rmSync(gates, { recursive: true, force: true }); }
}, 120000);
// branding compatibility (electron/branding-compat.json): peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
