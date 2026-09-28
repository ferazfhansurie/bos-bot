import { writeFileSync, unlinkSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

it("delivers a shared room message to a local bot and returns its answer", async () => {
  const fixture = await launchVerificationServer();
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const created = await api("POST", "/api/bots", {
      name: "Shared reply bot",
      modelSelection: { instanceId: "claude", model: "claude-sonnet-5" },
      requireAvailableModel: true,
    });
    expect(created.status).toBe(201);
    const bot = created.body.bot;
    const me = await api("GET", "/api/multiplayer/me");
    const dm = await api("POST", "/api/multiplayer/dm", { targetId: `${me.body.homeId}:bot:${bot.id}` });
    expect(dm.status).toBe(201);
    const roomId = dm.body.room.id;
    const sent = await api("POST", `/api/multiplayer/rooms/${roomId}/messages`, { text: "say hello", sendId: "shared-bot-send-1" });
    expect(sent.status).toBe(201);
    await expect.poll(async () => {
      const read = await api("GET", `/api/multiplayer/rooms/${roomId}/messages`);
      return read.body.messages.find((message: any) => message.actor.kind === "bot");
    }, { timeout: 20_000, interval: 250 }).toMatchObject({
      actor: { homeId: me.body.homeId, kind: "bot", localId: bot.id },
      responseTo: sent.body.message.id,
    });
  } finally {
    await fixture.close();
  }
}, 40_000);


it("delivers generated room images and documents as downloadable attachments without rerunning a retry", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(["[report](fixture-report.pdf)\n\n![image](fixture-image.png)"]), FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${fixture.info.url}${path}`, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    const bot = (await api("POST", "/api/bots", { name: "File bot", modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, requireAvailableModel: true })).body.bot;
    const me = (await api("GET", "/api/multiplayer/me")).body;
    const room = (await api("POST", "/api/multiplayer/dm", { targetId: `${me.homeId}:bot:${bot.id}` })).body.room;
    const path = `/api/multiplayer/rooms/${room.id}`;
    // Establish the real isolated room thread, then seed synthetic published
    // output in that thread's workspace. This does not claim tool availability.
    const setup = (await api("POST", `${path}/messages`, { text: "prepare", sendId: "file-setup" })).body.message;
    await expect.poll(async () => (await api("GET", `${path}/requests`)).body.requests.find((r: any) => r.sourceId === setup.id)?.state, { timeout: 15_000, interval: 200 }).toBe("completed");
    const tasks = (await api("GET", "/api/bots?messages=0")).body.bots.find((b: any) => b.id === bot.id).tasks;
    const thread = tasks.find((t: any) => t.title === `room · ${room.name}`);
    expect(thread).toBeTruthy();
    const folder = join(fixture.info.dataDir, "shared-room-files", thread.threadId);
    writeFileSync(join(folder, "fixture-report.pdf"), "%PDF-1.4\nroom fixture");
    writeFileSync(join(folder, "fixture-image.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64"));
    const payload = { text: "share the files", sendId: "generated-files" };
    const sent = (await api("POST", `${path}/messages`, payload)).body.message;
    let answer: any;
    await expect.poll(async () => {
      answer = (await api("GET", `${path}/messages`)).body.messages.find((m: any) => m.responseTo === sent.id && m.kind !== "activity");
      return answer?.attachments?.length;
    }, { timeout: 12_000, interval: 200 }).toBe(2);
    expect(answer.text).not.toContain("shared-room-files");
    expect(answer.attachments.map((a: any) => a.mime).sort()).toEqual(["application/pdf", "image/png"]);
    for (const attachment of answer.attachments) {
      const response = await fetch(`${fixture.info.url}${path}/attachments/${attachment.id}`);
      expect(response.status).toBe(200);
      const downloaded = await response.json() as any;
      expect(Buffer.from(downloaded.data, "base64").byteLength).toBe(attachment.size);
      expect(downloaded.attachment).toEqual(attachment);
    }
    const transcript = (await api("GET", `/api/threads/${thread.threadId}/messages`)).body.messages;
    const terminal = transcript.findLast((m: any) => m.role === "bot" && m.turnTerminal);
    const fileURL = `${fixture.info.url}/api/threads/${thread.threadId}/messages/${terminal.id}/file`;
    const download = () => fetch(fileURL, { method: "POST", headers: { "content-type": "application/json", origin: fixture.info.url }, body: JSON.stringify({ path: "fixture-report.pdf", sharedRoom: true }) });
    const scoped = await download();
    expect(scoped.status).toBe(200); expect(scoped.headers.get("x-bos-shared-file")).toBe("1");
    expect(await scoped.text()).toBe("%PDF-1.4\nroom fixture");
    const privateFile = join(fixture.info.dataDir, "private-fixture.pdf");
    writeFileSync(privateFile, "%PDF-1.4 private");
    unlinkSync(join(folder, "fixture-report.pdf")); symlinkSync(privateFile, join(folder, "fixture-report.pdf"));
    expect((await download()).status).toBe(403);
    expect((await api("POST", `${path}/messages`, payload)).status).toBe(200);
    const finals = (await api("GET", `${path}/messages`)).body.messages.filter((m: any) => m.responseTo === sent.id && m.kind !== "activity");
    expect(finals).toHaveLength(1); expect(finals[0].attachments).toEqual(answer.attachments);
  } finally { await fixture.close(); }
}, 50_000);
