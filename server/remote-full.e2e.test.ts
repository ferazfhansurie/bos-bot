import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("real isolated server refuses loopback, ordinary paired elevation and unenrolled signed-grant attempts", async () => {
  const f = await launchVerificationServer(); const evidence: unknown[] = [];
  const call = async (path: string, method = "GET", body?: unknown, token?: string) => {
    const r = await fetch(f.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await r.json() as any; evidence.push({ path, method, status: r.status, result: path.includes("auth/") ? "redacted pairing response" : json }); return { status: r.status, json };
  };
  try {
    const b = (await call("/api/bots", "POST", { name: "Permission fixture" })).json.bot;
    const pairing = await call("/api/auth/pairing", "POST", { scopes: ["client"] });
    const pair = await call("/api/auth/pair", "POST", { code: pairing.json.code, label: "remote approval fixture" });
    const token = pair.json.token; expect(typeof token).toBe("string");
    expect((await call("/api/remote-full/status")).status).toBe(403);
    expect((await call("/api/remote-full/status", "GET", undefined, token)).json).toMatchObject({ protocol: 1, enrolled: false });
    const targets = [{ botId: b.id, threadId: b.threadId, updateBotDefault: true }];
    expect((await call("/api/remote-full/prepare", "POST", targets)).status).toBe(403);
    expect((await call("/api/remote-full/prepare", "POST", targets, token)).status).toBe(403);
    expect((await call("/api/remote-full/commit", "POST", { confirmed: true }, token)).status).toBe(403);
    expect((await call(`/api/bots/${b.id}`, "PATCH", { approvalMode: "full", confirmFullAccess: true })).status).toBe(403);
    expect((await call(`/api/bots/${b.id}/tasks/${b.threadId}`, "PATCH", { approvalMode: "full" }, token)).status).toBe(403);
    const bots = (await call("/api/bots")).json.bots; expect(bots.find((v: any) => v.id === b.id).approvalMode ?? "ask").toBe("ask");
  } finally { writeFileSync(`${f.info.logPath}.remote-full.json`, JSON.stringify(evidence, null, 2)); console.log(`remote-full fixture evidence: ${f.info.logPath}.remote-full.json`); await f.close(); }
}, 60000);
