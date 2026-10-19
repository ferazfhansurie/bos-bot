import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("staff can discover image support without provider credentials or unused engines", async () => {
  const fixture = await launchVerificationServer();
  const remote = { host: "staff.test", "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "https", origin: "https://staff.test" };
  const api = (method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie?: string }> => new Promise((resolve, reject) => {
    const req = httpRequest(fixture.info.url + path, { method, headers: { "content-type": Buffer.isBuffer(body) ? "image/png" : "application/json", ...(cookie ? { ...remote, cookie } : {}) } }, res => {
      let raw = "";
      res.on("data", chunk => { raw += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
  try {
    const created = await api("POST", "/api/auth/password-logins", { name: "Staff", username: "staff" });
    const login = await api("POST", "/api/auth/password", { username: "staff", password: created.body.password });
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    for (const initial of (await api("GET", "/api/bots?messages=0")).body.bots) {
      expect((await api("PATCH", `/api/bots/${initial.id}`, { visibility: "private" })).status).toBe(200);
    }
    // No accessible bot means no provider metadata is disclosed.
    expect((await api("GET", "/api/instances", undefined, cookie)).body.instances).toEqual([]);
    const bot = await api("POST", "/api/bots", { name: "Studio fixture", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
    expect(bot.status).toBe(201);
    const catalog = await api("GET", "/api/instances", undefined, cookie);
    expect(catalog.status).toBe(200);
    expect(catalog.body.instances.map((i: any) => i.instanceId)).toEqual(["claude"]);
    const instance = catalog.body.instances[0];
    expect(instance.capabilities.images).toBe(true);
    for (const key of ["cli", "cliCandidates", "cliDefault", "install", "claudeAccount", "authentication", "environment", "config"]) expect(instance).not.toHaveProperty(key);
    expect(instance.snapshot).not.toHaveProperty("account");
    expect(instance.snapshot).not.toHaveProperty("version");
    expect((await api("GET", "/api/instances")).body.instances.find((i: any) => i.instanceId === "claude")).toHaveProperty("cli");
    expect((await api("PATCH", "/api/instances/claude", { cli: "/fixture/forbidden" }, cookie)).status).toBe(403);
    expect((await api("POST", "/api/instances/claude/auth/start", {}, cookie)).status).toBe(403);
    const pixels = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=", "base64");
    const uploaded = await api("POST", "/api/attachments", pixels, cookie);
    expect(uploaded.status).toBe(201);
    expect((await api("POST", `/api/bots/${bot.body.bot.id}/messages`, {
      threadId: bot.body.bot.threadId, text: `describe this fixture\n\n<attached-image path="${uploaded.body.path}" name="fixture.png" />`,
    }, cookie)).status).toBe(202);
    await expect.poll(async () => (await api("GET", `/api/threads/${bot.body.bot.threadId}/messages`, undefined, cookie)).body.messages.some((m: any) => m.role === "bot" && m.text === "hello from fake claude"), { timeout: 15000 }).toBe(true);
    const captured = JSON.parse(readFileSync(join(fixture.info.dataDir, "fake-claude-dump.json"), "utf8"));
    expect(captured.prompt.message.content.filter((item: any) => item.type === "image")).toHaveLength(1);
    expect((await api("PATCH", `/api/bots/${bot.body.bot.id}`, { visibility: "private" })).status).toBe(200);
    expect((await api("GET", "/api/instances", undefined, cookie)).body.instances).toEqual([]);
  } finally {
    await fixture.close();
  }
}, 45000);
