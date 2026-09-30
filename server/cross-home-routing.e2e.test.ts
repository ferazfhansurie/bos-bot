import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

test("two real isolated homes forward Chief tools and resume once for coordination and owner-reviewed setup", async () => {
  const gates = mkdtempSync(join(tmpdir(), "chief-routing-"));
  const gate = join(gates, "finish");
  const remote = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(["remote bounded result"]) });
  let local: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
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
    const grant = { granteeHomeId: localHome, granteeBotId: chief.id, peerSessionId: paired.session.id, peerTokenHash: createHash("sha256").update(paired.token).digest("hex"),
      scopes: ["coordinate", "bots:create", "bots:delete", "bots:configure"], section: "", note: "two-home fixture" };
    const grantFile = join(remote.info.dataDir, "delegations.json");
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
    const delegated = roster.bots.find((bot: any) => bot.home === remoteHome);
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
    expect(proposal.state).toBe("pending"); expect(proposal.review).toBe("partner review");
    writeFileSync(gate, "finish");
    const reviewBot = (await api(remote, "GET", "/api/bots")).bots.find((bot: any) => bot.id === proposal.reviewBotId);
    const reviewTask = reviewBot.tasks.find((task: any) => task.openedBy?.name === "Remote Chief setup review");
    await api(remote, "POST", `/api/threads/${reviewTask.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    await expect.poll(() => handoffs().find((node: any) => node.delegatedProposalId === proposal.requestId)?.status, { timeout: 30000 }).toBe("completed");
    await expect.poll(() => handoffs().filter((node: any) => !node.parentId).every((node: any) => node.status === "completed"), { timeout: 30000 }).toBe(true);
    expect(handoffs().filter((node: any) => !node.parentId).map((node: any) => node.executions)).toEqual([2, 2]);
    expect((await api(remote, "GET", "/api/bots")).bots.find((bot: any) => bot.id === target.id).title).toBe("Reviewed remote lead");
    expect((await api(remote, "GET", "/api/bots")).bots.find((bot: any) => bot.id === target.id).chiefOfStaff).toBe(target.chiefOfStaff);
    await expect.poll(async () => !(await api(local!, "GET", "/api/bots")).bots.find((bot: any) => bot.id === chief.id).busy, { timeout: 15000 }).toBe(true);
    previousPid = JSON.parse(readFileSync(local.fixtureDumpPath, "utf8")).pid;
    capability = await begin();
    for (let i = 0; i < 24; i++) await api(local, "POST", "/api/internal/coordinate-bots", { botIds: [delegated.id], requestKey: `budget-${i}`, message: "fixture queued only" }, capability);
    const untracked = await api(local, "POST", "/api/internal/team-setup-requests", { home: remoteHome, plan: { reason: "tracking budget fixture", operations: [{ action: "update", botId: target.id, fields: { title: "Pending only" } }] } }, capability, 201);
    expect(untracked.state).toBe("pending"); expect(untracked.routing).toBe("unavailable");
    expect(untracked.requestId).toMatch(/^[\w-]+$/); expect(untracked.warning).toMatch(/do not repeat/i);
    expect(handoffs().some((node: any) => node.delegatedProposalId === untracked.requestId)).toBe(false);
    expect((await api(remote, "GET", "/api/bots")).bots.find((bot: any) => bot.id === target.id).title).toBe("Reviewed remote lead");
  } finally { await local?.close(); await remote.close(); rmSync(gates, { recursive: true, force: true }); }
}, 120000);
