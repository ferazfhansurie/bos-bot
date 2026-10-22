import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";

// A gateway pairs one client-only session per signed-in person and binds the
// person to it. Every turn that session starts carries the member to the
// bot's own tools, out of reach of config files and the model.
describe("member identity through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  const member = { userId: "sam@example.com", name: "Sam", email: "sam@example.com", roles: ["Sales User"], claims: { pic_name: "SAM" } };
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };

  beforeAll(async () => { fixture = await launchVerificationServer(); });
  afterAll(async () => { await fixture?.close(); });

  it("binds a member only to a one-use client pairing", async () => {
    expect((await api("POST", "/api/auth/pairing", { scopes: ["client", "admin"], member })).status).toBe(400);
    expect((await api("POST", "/api/auth/pairing", { scopes: ["client"], reusable: true, member })).status).toBe(400);
    expect((await api("POST", "/api/auth/pairing", { scopes: ["client"], member: { userId: "x", role: "boss" } })).status).toBe(400);
  });

  it("hands the sender to the engine and the member to custom tools, which no config can claim", async () => {
    const claimed = await api("POST", "/api/mcp/servers", { name: "crm", command: process.execPath, env: { BOS_MEMBER: "{\"userId\":\"boss\"}" } });
    expect(claimed.body.error).toMatch(/BOS_MEMBER.*reserved/);
    const added = await api("POST", "/api/mcp/servers", { name: "crm", command: process.execPath, args: ["crm.mjs"], enabled: true, autoApprove: ["my_day"] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect((await api("PATCH", "/api/mcp/servers/crm", { enabled: true })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Sales" })).body.bot;
    const code = (await api("POST", "/api/auth/pairing", { scopes: ["client"], label: "Sam (sam@example.com)", member })).body.code;
    const joined = await api("POST", "/api/auth/pair", { code, label: "Sam (sam@example.com)" });
    expect(joined.status).toBe(200);
    expect(joined.body.session.member).toEqual(member);
    const sent = await api("POST", `/api/bots/${bot.id}/messages`, { text: "my day please", threadId: bot.threadId }, { authorization: `Bearer ${joined.body.token}` });
    expect(sent.status).toBe(202);
    const dump = await expect.poll(() => {
      try { return JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")); } catch { return null; }
    }, { timeout: 15_000 }).not.toBeNull().then(() => JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8")));
    expect(JSON.stringify(dump.prompt)).toContain("[sent by Sam (sam@example.com) · roles: Sales User]");
    const crm = dump.mcpConfig.mcpServers.crm;
    const env = crm.env.OMB_GATE_UPSTREAM ? JSON.parse(crm.env.OMB_GATE_UPSTREAM).env : crm.env;
    const expected = { ...member, sessionId: joined.body.session.id };
    expect(JSON.parse(env.BOS_MEMBER)).toEqual(expected);
    if (crm.env.OMB_GATE_UPSTREAM) expect(JSON.parse(crm.env.OMB_GATE_MEMBER)).toEqual(expected);
    const allowed = dump.argv[dump.argv.indexOf("--allowedTools") + 1];
    expect(allowed.split(",")).toContain("mcp__crm__my_day");
    expect(allowed.split(",")).not.toContain("mcp__crm");
  });
});
