import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

test("a trusted peer link's threads follow the bot's own approval level; untrusting pins them to ask", async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_REPLIES: JSON.stringify(["bounded fixture reply"]) });
  try {
    const api = async (method: string, path: string, body?: unknown, token?: string, expected = 200, delegated = false) => {
      const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url,
        ...(token ? { authorization: `Bearer ${token}` } : {}), ...(delegated ? { "x-bos-grantee-home": "putri", "x-bos-grantee-bot": "pixie" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const result = await response.json() as any;
      expect(response.status, JSON.stringify(result)).toBe(expected); return result;
    };
    const pairing = await api("POST", "/api/auth/pairing", { scopes: ["peer"] });
    const paired = await api("POST", "/api/auth/pair", { code: pairing.code });
    const token = paired.token;
    writeFileSync(join(fixture.info.dataDir, "cross-home-grants.json"), JSON.stringify({ version: 1, delegations: [{ granteeHomeId: "putri", granteeBotId: "pixie",
      peerSessionId: paired.session.id, peerTokenHash: createHash("sha256").update(token).digest("hex"), scopes: ["coordinate"], section: "", note: "fixture" }] }));
    const bot = (await api("GET", "/api/bots")).bots[0];
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "auto" });
    const task = (await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Putri · linked Mac" }, token, 201)).task;
    const mode = async (threadId: string) => (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.threadId === threadId).approvalMode;
    expect(await mode(task.threadId)).toBe("ask");

    await api("POST", "/api/multiplayer/peer-trust", { sessionId: paired.session.id, trusted: true });
    expect(await mode(task.threadId)).toBeUndefined();
    const job = await api("POST", "/api/delegated/coordinate", { botId: bot.id, requestKey: "trusted", message: "reply only fixture" }, token, 200, true);
    await expect.poll(async () => (await api("GET", `/api/delegated/coordinate/${job.requestId}`, undefined, token, 200, true)).status, { timeout: 30000 }).toBe("completed");
    const remote = (await api("GET", "/api/bots")).bots.find((entry: any) => entry.id === bot.id).tasks.find((entry: any) => entry.openedBy?.name === "Remote Chief");
    expect(remote.approvalMode).toBeUndefined();

    await api("POST", "/api/multiplayer/peer-trust", { sessionId: paired.session.id, trusted: false });
    expect(await mode(task.threadId)).toBe("ask");
  } finally { await fixture.close(); }
}, 90000);
