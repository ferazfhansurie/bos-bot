import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

test("real peer endpoints deny ungranted authority, recheck revocation at review and preserve target permissions", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(["bounded fixture reply"]) });
  try {
    const api = async (method: string, path: string, body?: unknown, token?: string, expected = 200, grantee = "jarvis", home = "firaz") => {
      const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}`, "x-bos-grantee-home": home, "x-bos-grantee-bot": grantee } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as any;
      expect(response.status, JSON.stringify(result)).toBe(expected); return result;
    };
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api("POST", "/api/auth/pair", { code: pairing.code });
    const token = paired.token;
    const grant = { granteeHomeId: "firaz", granteeBotId: "jarvis", peerSessionId: paired.session.id,
      peerTokenHash: createHash("sha256").update(token).digest("hex"), scopes: ["coordinate", "bots:create", "bots:delete", "bots:configure"], section: "", note: "fixture" };
    const config = (entry: any[] = [grant]) => writeFileSync(join(fixture.info.dataDir, "delegations.json"), JSON.stringify({ version: 1, delegations: entry }));
    const bots = (await api("GET", "/api/bots")).bots;
    const recipient = bots[0];
    const selection = recipient.modelSelection;
    const sibling = (await api("POST", "/api/bots", { name: "Second", title: "Fixture", modelSelection: selection }, undefined, 201)).bot;
    await api("POST", "/api/bots", { name: "Private", title: "Other section", section: "private", modelSelection: selection }, undefined, 201);
    await api("GET", "/api/delegated/roster", undefined, token, 403);
    await api("GET", "/api/delegated/roster", undefined, undefined, 403);
    for (const [method, path, body] of [["POST", "/api/delegated/coordinate", { botId: recipient.id, requestKey: "one", message: "fixture" }],
      ["POST", "/api/delegated/bots", {}], ["DELETE", `/api/delegated/bots/${sibling.id}`, { reason: "fixture" }]] as const) await api(method, path, body, token, 403);
    config();
    const roster = await api("GET", "/api/delegated/roster", undefined, token);
    expect(roster.bots.map((bot: any) => bot.name)).not.toContain("Private");
    await api("GET", "/api/delegated/roster", undefined, token, 403, "wrong");
    await api("GET", "/api/delegated/roster", undefined, token, 403, "jarvis", "wrong");
    config([{ ...grant, expiresAt: Date.now() - 1 }]);
    await api("GET", "/api/delegated/roster", undefined, token, 403);
    writeFileSync(join(fixture.info.dataDir, "delegations.json"), "malformed");
    await api("GET", "/api/delegated/roster", undefined, token, 403);
    config();
    await api("PATCH", `/api/delegated/bots/${recipient.id}`, { reason: "forbidden permission field", fields: { approvalMode: "full" } }, token, 400);
    await api("PATCH", `/api/delegated/bots/${recipient.id}`, { reason: "forbidden section move", fields: { section: "private" } }, token, 403);
    const fields = { name: "Remote-created", title: "Fixture", soul: "Use own permissions", modelSelection: selection };
    const proposal = await api("POST", "/api/delegated/bots", { key: "remote", fields, reason: "fixture request" }, token, 201);
    expect(proposal.state).toBe("pending"); expect(proposal.review).toBe("partner review");
    const reviewBot = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === proposal.reviewBotId);
    const reviewTask = reviewBot.tasks.find((task: any) => task.openedBy?.name === "Remote Chief setup review");
    expect(reviewTask).toBeDefined();
    config([]);
    const denied = await api("POST", `/api/threads/${reviewTask.threadId}/respond`, { requestId: proposal.requestId, behavior: "allow" });
    expect(denied.result.state).toBe("cancelled");
    expect((await api("GET", "/api/bots")).bots.some((bot: any) => bot.name === "Remote-created")).toBe(false);
    config();
    const fresh = await api("POST", "/api/delegated/bots", { key: "remote", fields, reason: "fixture request" }, token, 201);
    await api("POST", `/api/threads/${reviewTask.threadId}/respond`, { requestId: fresh.requestId, behavior: "allow" });
    const created = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.name === "Remote-created");
    expect(created.autoApprove).toBe(false); expect(created.chiefOfStaff).not.toBe(true);
    const coordinate = { botId: recipient.id, requestKey: "one", message: "reply only fixture" };
    const first = await api("POST", "/api/delegated/coordinate", coordinate, token);
    const duplicate = await api("POST", "/api/delegated/coordinate", coordinate, token);
    expect(duplicate.requestId).toBe(first.requestId); expect(duplicate.duplicate).toBe(true);
    await expect.poll(async () => (await api("GET", `/api/delegated/coordinate/${first.requestId}`, undefined, token)).status, { timeout: 30000 }).toBe("completed");
    const after = (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === recipient.id);
    expect(after.approvalMode).toBe(recipient.approvalMode);
    expect(after.tasks.find((task: any) => task.openedBy?.name === "Remote Chief").approvalMode).toBe("ask");
    const durable = JSON.parse(readFileSync(join(fixture.info.dataDir, "delegated-jobs.json"), "utf8"));
    expect(durable.filter((job: any) => job.requestKey === "one")).toHaveLength(1);
    await expect.poll(async () => (await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === recipient.id).busy, { timeout: 15000 }).toBe(false);
    await api("PATCH", `/api/bots/${recipient.id}`, { visibility: "private" });
    expect((await api("GET", "/api/delegated/roster", undefined, token)).bots.some((bot: any) => bot.id === recipient.id)).toBe(false);
    expect((await api("GET", "/api/delegated/catalog", undefined, token)).bots.some((bot: any) => bot.id === recipient.id)).toBe(false);
    await api("POST", "/api/delegated/coordinate", { ...coordinate, requestKey: "private-denied" }, token, 403);
    await api("PATCH", `/api/delegated/bots/${recipient.id}`, { reason: "private denied", fields: { title: "Leaked" } }, token, 403);
    await api("DELETE", `/api/delegated/bots/${recipient.id}`, { reason: "private denied" }, token, 403);
    await api("GET", `/api/delegated/coordinate/${first.requestId}`, undefined, token, 403);
  } finally { await fixture.close(); }
}, 90000);


test("delegated deletion refuses a target with running work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "chief-busy-"));
  const gate = join(dir, "finish");
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: gate });
  try {
    const api = async (method: string, path: string, body?: unknown, token?: string) => {
      const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}`, "x-bos-grantee-home": "firaz", "x-bos-grantee-bot": "jarvis" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() as any };
    };
    const recipient = (await api("GET", "/api/bots")).body.bots[0];
    await api("POST", "/api/bots", { name: "Reviewer", title: "Fixture", modelSelection: recipient.modelSelection });
    const pairing = (await api("POST", "/api/auth/pairing", { scopes: ["peer"] })).body;
    const paired = (await api("POST", "/api/auth/pair", { code: pairing.code })).body;
    writeFileSync(join(fixture.info.dataDir, "delegations.json"), JSON.stringify({ version: 1, delegations: [{ granteeHomeId: "firaz", granteeBotId: "jarvis", peerSessionId: paired.session.id,
      peerTokenHash: createHash("sha256").update(paired.token).digest("hex"), scopes: ["coordinate", "bots:create", "bots:delete", "bots:configure"], section: "", note: "fixture" }] }));
    await runControlOmb(["send", "--bot", recipient.id, "--task", recipient.threadId, "--text", "hold for deletion check", "--url", fixture.info.url]);
    await expect.poll(async () => (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === recipient.id).busy, { timeout: 15000 }).toBe(true);
    const refusal = await api("DELETE", `/api/delegated/bots/${recipient.id}`, { reason: "fixture" }, paired.token);
    expect(refusal.status).toBe(409); expect(refusal.body.error).toMatch(/working|Stop/);
    expect((await api("GET", "/api/bots")).body.bots.some((bot: any) => bot.id === recipient.id)).toBe(true);
    const queued = await api("POST", "/api/delegated/coordinate", { botId: recipient.id, requestKey: "revoked-queued", message: "must not dispatch after revocation" }, paired.token);
    expect(queued.status).toBe(200);
    writeFileSync(join(fixture.info.dataDir, "delegations.json"), JSON.stringify({ version: 1, delegations: [] }));
    writeFileSync(gate, "finish");
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.info.dataDir, "delegated-jobs.json"), "utf8")).find((job: any) => job.id === queued.body.requestId).status, { timeout: 15000 }).toBe("failed");
    const threads = (await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === recipient.id).tasks;
    expect(threads.some((task: any) => task.openedBy?.name === "Remote Chief")).toBe(false);
  } finally { await fixture.close(); rmSync(dir, { recursive: true, force: true }); }
}, 60000);
