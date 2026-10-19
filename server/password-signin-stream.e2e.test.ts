import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("delivers staff replies live while suppressing owner-private conversation events", async () => {
  const fixture = await launchVerificationServer();
  const { url } = fixture.info;
  const host = "staff.test";
  const remote = { host, "x-forwarded-for": "203.0.113.10", "x-forwarded-proto": "https", origin: `https://${host}` };
  const api = (method: string, path: string, body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie?: string }> => new Promise((resolve, reject) => {
    const req = httpRequest(url + path, { method, headers: { "content-type": "application/json", ...(cookie ? { ...remote, cookie } : {}) } }, res => {
      let raw = "";
      res.on("data", chunk => { raw += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), cookie: res.headers["set-cookie"]?.[0]?.split(";")[0] }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const frames: any[] = [];
  let stream: ReturnType<typeof httpRequest> | undefined;
  try {
    const created = await api("POST", "/api/auth/password-logins", { name: "Staff", username: "staff" });
    const login = await api("POST", "/api/auth/password", { username: "staff", password: created.body.password });
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    const createBot = async (name: string) => {
      const result = await api("POST", "/api/bots", { name, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true });
      expect(result.status).toBe(201);
      return result.body.bot;
    };
    const shared = await createBot("Shared fixture");
    const privateBot = await createBot("Owner private fixture");
    expect((await api("PATCH", `/api/bots/${privateBot.id}`, { visibility: "private" })).status).toBe(200);
    await new Promise<void>((resolve, reject) => {
      stream = httpRequest(url + "/api/events", { headers: { ...remote, cookie } }, res => {
        try { expect(res.statusCode).toBe(200); } catch (error) { reject(error); }
        let pending = "";
        res.on("data", chunk => {
          pending += String(chunk);
          let end: number;
          while ((end = pending.indexOf("\n\n")) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const data = frame.split("\n").find(line => line.startsWith("data: "));
            if (!data) continue;
            const parsed = JSON.parse(data.slice(6)); frames.push(parsed);
            if (parsed.kind === "hello") resolve();
          }
        });
      });
      stream.on("error", reject); stream.end();
    });
    const send = (bot: any, cookie?: string) => api("POST", `/api/bots/${bot.id}/messages`, { text: "hello fixture", threadId: bot.threadId, sender: { id: "forged-owner", name: "Forged owner" } }, cookie);
    const sent = await send(shared, cookie);
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    await expect.poll(() => frames.some(frame => frame.kind === "message" && frame.threadId === shared.threadId && frame.message?.role === "bot" && frame.message?.text === "hello from fake claude"), { timeout: 15000 }).toBe(true);
    expect(frames.some(frame => frame.kind === "bot" && frame.bot?.id === shared.id && frame.bot.threadId === shared.threadId)).toBe(true);
    const actor = (await api("GET", "/api/multiplayer/me", undefined, cookie)).body.actorId;
    const messages = (await api("GET", `/api/threads/${shared.threadId}/messages`, undefined, cookie)).body.messages;
    expect(messages.find((message: any) => message.role === "user").sender).toEqual({ id: actor, name: "Staff" });
    expect(actor).toContain(`:person:password-${created.body.login.id}`);
    expect((await send(privateBot)).status).toBe(202);
    await expect.poll(async () => (await api("GET", `/api/threads/${privateBot.threadId}/messages`)).body.messages.some((message: any) => message.role === "bot" && message.text === "hello from fake claude"), { timeout: 15000 }).toBe(true);
    expect(JSON.stringify(frames)).not.toContain(privateBot.threadId);
    expect(JSON.stringify(frames)).not.toContain(privateBot.id);
    // A visibility change revokes direct reply events on the existing stream.
    expect((await api("PATCH", `/api/bots/${shared.id}`, { visibility: "private" })).status).toBe(200);
    await expect.poll(() => frames.some(frame => frame.kind === "bot.deleted" && frame.botId === shared.id)).toBe(true);
    frames.length = 0;
    expect((await send(shared)).status).toBe(202);
    await expect.poll(async () => (await api("GET", `/api/threads/${shared.threadId}/messages`)).body.messages.filter((message: any) => message.role === "bot" && message.text === "hello from fake claude").length, { timeout: 15000 }).toBe(2);
    expect(frames.some(frame => frame.threadId === shared.threadId || frame.event?.threadId === shared.threadId)).toBe(false);
    // A fresh session and a promotion change authority, never the human id.
    expect((await api("PATCH", `/api/auth/password-logins/${created.body.login.id}`, { role: "admin" })).status).toBe(200);
    const promoted = await api("POST", "/api/auth/password", { username: "staff", password: created.body.password });
    expect(promoted.body.session.scopes).toEqual(["admin", "client"]);
    expect((await api("GET", "/api/multiplayer/me", undefined, promoted.cookie)).body.actorId).toBe(actor);
    expect((await api("PATCH", `/api/bots/${shared.id}`, { visibility: "shared" })).status).toBe(200);
    expect((await send(shared, promoted.cookie)).status).toBe(202);
    await expect.poll(async () => (await api("GET", `/api/threads/${shared.threadId}/messages`)).body.messages.filter((message: any) => message.role === "user" && message.sender?.id === actor).length, { timeout: 15000 }).toBe(2);
    const confirmed = (await api("GET", `/api/threads/${shared.threadId}/messages`)).body.messages.filter((message: any) => message.role === "user" && message.sender?.id === actor);
    expect(confirmed.every((message: any) => message.sender.name === "Staff")).toBe(true);
  } finally {
    stream?.destroy();
    await fixture.close();
  }
}, 45000);
