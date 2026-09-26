import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { REMOTE_BOT_UNAVAILABLE } from "../shared/wire.ts";
import { homeKey, isRemoteBotPath, RemoteBotBridge, type BridgeLink, type BridgeResponse } from "./remote-bot-bridge.ts";

const TOKEN = "omb_sess_linktoken-secret";
const HOME = "home-putri";
const KEY = homeKey(HOME);
const SECRET = "putri-secret";

interface Call { method: string; path: string; search: string; body: unknown; headers: Record<string, string>; raw?: Uint8Array }

/** A fake home B: Putri's bot "pixie" with her own private thread. */
class FakeHome {
  calls: Call[] = [];
  threads = new Map<string, Array<Record<string, unknown>>>([["putri-thread", [{ id: "p1", role: "user", kind: "text", text: `${SECRET} message`, at: 1 }]]]);
  tasks: Array<Record<string, unknown>> = [{ threadId: "putri-thread", title: `${SECRET} title`, createdAt: 1 }];
  selected = "putri-thread";
  created = 0;
  streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  streamUrls: URL[] = [];
  holdMessages: (() => void) | null = null;
  /** Putri's bot is on a Custom approval setting a client may not leave. */
  customApproval = false;
  extraBots: Array<Record<string, unknown>> = [];

  bot(): Record<string, unknown> {
    return {
      id: "pixie", name: "Pixie", title: "Helper", description: "", color: "blue", avatarUrl: "/api/attachments/aaaa-bbbb.png",
      modelSelection: { instanceId: "claude", model: "opus" }, notifications: true, createdAt: 5,
      soul: `${SECRET} soul`, cwd: `/Users/owner/${SECRET}`,
      threadId: this.selected, tasks: this.tasks, messages: this.threads.get(this.selected) ?? [],
    };
  }

  push(frame: Record<string, unknown>, id?: string): void {
    const text = `${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(frame)}\n\n`;
    this.streams.at(-1)!.enqueue(new TextEncoder().encode(text));
  }

  fetcher = (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const raw = init.body instanceof Uint8Array ? init.body : undefined;
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const method = init.method ?? "GET";
    this.calls.push({ method, path: url.pathname, search: url.search, body, headers, raw });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/events") {
      this.streamUrls.push(url);
      const stream = new ReadableStream<Uint8Array>({ start: (controller) => { this.streams.push(controller); } });
      init.signal?.addEventListener("abort", () => { try { this.streams.at(-1)?.error(new Error("aborted")); } catch { /* closed */ } });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "GET" && url.pathname === "/api/bots") {
      return json(200, { bots: [this.bot(), ...this.extraBots, { id: "hidden-bot", name: "H", title: "", hidden: true, tasks: [] }],
        botQueuedMessages: { "putri-thread": [{ queueId: "q-secret", text: `${SECRET} queued` }] }, groups: [{ id: "g", messages: [{ text: SECRET }] }] });
    }
    if (method === "POST" && url.pathname === "/api/bots/pixie/tasks") {
      const threadId = `bridge-${++this.created}`;
      // like B's store: a new thread inherits the bot's approval mode and grants
      const task: Record<string, unknown> = { threadId, title: (body as { title?: string }).title ?? "New chat", createdAt: Date.now(),
        modelSelection: { instanceId: "claude", model: "opus" }, approvalMode: this.customApproval ? "custom" : "auto", autoApprove: !this.customApproval };
      this.tasks.push(task);
      this.threads.set(threadId, []);
      this.selected = threadId;
      return json(201, { task, bot: this.bot() });
    }
    let match = /^\/api\/bots\/pixie\/tasks\/([\w-]+)$/.exec(url.pathname);
    if (match && method === "POST") {
      this.selected = match[1]!;
      return json(200, { bot: this.bot() });
    }
    if (match && method === "PATCH") {
      const task = this.tasks.find((candidate) => candidate.threadId === match![1]);
      if (!task) return json(404, { error: "no such task" });
      if (this.customApproval) return json(403, { error: "Leaving Custom approval requires confirmation in the packaged desktop app" });
      const patch = body as Record<string, unknown>;
      if (patch.resetApprovalToAsk === true) Object.assign(task, { approvalMode: "ask", autoApprove: false });
      for (const key of ["title", "archivedAt", "pinnedMessageId"]) if (patch[key] !== undefined) task[key] = patch[key];
      return json(200, { task, bot: this.bot() });
    }
    if (match && method === "DELETE") {
      this.tasks = this.tasks.filter((candidate) => candidate.threadId !== match![1]);
      this.threads.delete(match[1]!);
      return json(200, { bot: this.bot() });
    }
    match = /^\/api\/threads\/([\w-]+)\/messages$/.exec(url.pathname);
    if (match && method === "GET") {
      const messages = this.threads.get(match[1]!) ?? [];
      return json(200, { messages, hasMore: false, activeLeafId: (messages.at(-1)?.id as string | undefined) ?? null });
    }
    if (method === "POST" && url.pathname === "/api/attachments") {
      return json(200, { path: `/Users/owner/.bos-bot/attachments/${url.searchParams.get("uploadId")}.png`, uploadId: url.searchParams.get("uploadId") });
    }
    if (method === "POST" && url.pathname === "/api/files") {
      return json(200, { path: `/Users/owner/.bos-bot/attachments/${url.searchParams.get("uploadId")}.pdf` });
    }
    if (method === "POST" && url.pathname === "/api/bots/pixie/messages") {
      if (this.holdMessages === null) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const b = body as { text: string; threadId: string };
      const message = { id: `u${this.calls.length}`, role: "user", kind: "text", text: b.text, at: Date.now() };
      this.threads.get(b.threadId)?.push(message);
      return json(200, { ok: true, threadId: b.threadId, message, bot: this.bot() });
    }
    if (method === "POST" && /^\/api\/threads\/[\w-]+\/respond$/.test(url.pathname)) return json(200, { ok: true });
    if (method === "POST" && /^\/api\/bots\/pixie\/(interrupt|read|respond)$/.test(url.pathname)) {
      return json(200, { ok: true, threadId: (body as { threadId: string }).threadId, stopped: true, groupId: "g-secret" });
    }
    return json(404, { error: "no such route" });
  }) as typeof fetch;
}

const until = async (condition: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

describe("RemoteBotBridge", () => {
  let dir: string;
  let fake: FakeHome;
  let frames: Array<Record<string, any>>;
  let notices: unknown[];
  let queueChanges: number;
  let bridge: RemoteBotBridge;
  const link: BridgeLink = { homeId: HOME, origin: "https://putri.tail1234.ts.net", token: TOKEN, name: "Putri's Mac", ownerName: "Putri" };
  const make = () => new RemoteBotBridge({
    file: join(dir, "remote-bots.json"),
    links: () => [link],
    broadcast: (frame) => frames.push(JSON.parse(JSON.stringify(frame))),
    notify: (notification) => notices.push(notification),
    queuesChanged: () => { queueChanges += 1; },
    localOwnerName: () => "Firaz",
    attachmentsDir: join(dir, "attachments"),
    fileMime: (ext) => (ext === ".pdf" ? "application/pdf" : null),
    fetcher: fake.fetcher,
    reconnectDelaysMs: [5],
    idleTimeoutMs: 2000,
    log: () => {},
  });
  const botId = `rb-${KEY}-pixie`;
  const route = (method: string, path: string, body?: unknown, search = "") =>
    bridge.route(method, path, new URLSearchParams(search), async () => body ?? {});
  const jsonOf = (answer: BridgeResponse) => ("json" in answer ? answer.json as any : null);
  const pending = `rt-${KEY}-pending-pixie`;
  const taskCreates = () => fake.calls.filter((call) => call.method === "POST" && call.path === "/api/bots/pixie/tasks").length;
  /** The first real message: what opens the bridge thread on B. */
  const firstSend = async () => {
    const answer = await route("POST", `/api/bots/${botId}/messages`, { text: "hi pixie", threadId: pending });
    expect(answer.status).toBe(200);
    return answer;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-remote-bots-"));
    writeFileSync(join(dir, "placeholder"), "");
    fake = new FakeHome();
    frames = [];
    notices = [];
    queueChanges = 0;
    bridge = make();
  });
  afterEach(() => {
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("recognises only virtual ids as bridge paths", () => {
    expect(isRemoteBotPath(`/api/bots/${botId}/messages`)).toBe(true);
    expect(isRemoteBotPath(`/api/threads/rt-${KEY}-bridge-1/messages`)).toBe(true);
    expect(isRemoteBotPath("/api/bots/pixie/messages")).toBe(false);
    expect(isRemoteBotPath("/api/bots")).toBe(false);
  });

  it("lists a remote bot as an ordinary bot and opens a thread on B only on the first send", async () => {
    const [idle, ...rest] = await bridge.listBots(50);
    expect(rest).toHaveLength(0); // the hidden bot is not shared
    expect(idle!.id).toBe(botId);
    expect(idle!.id).toMatch(/^[\w-]+$/);
    expect(idle!.threadId).toBe(pending);
    expect(idle!.tasks).toEqual([]);
    expect(idle!.messages).toEqual([]);
    expect(taskCreates()).toBe(0);
    expect(jsonOf(await route("GET", `/api/threads/${pending}/messages`))).toEqual({ messages: [], hasMore: false, activeLeafId: null });
    const sent = await firstSend();
    expect(jsonOf(sent).threadId).toBe(`rt-${KEY}-bridge-1`);
    expect(taskCreates()).toBe(1);
    const [bot] = await bridge.listBots(50);
    expect(bot!.threadId).toBe(`rt-${KEY}-bridge-1`);
    expect(bot!.tasks.map((task) => task.threadId)).toEqual([`rt-${KEY}-bridge-1`]);
    expect(bot!.remote).toEqual({ homeId: HOME, homeName: "Putri's Mac", ownerName: "Putri" });
    expect(bot!.messages.map((message) => message.text)).toEqual(["hi pixie"]);
    expect(bot!.computer).toBe("off");
    // the thread was opened on B with this home's title, and B's own selection put back
    const create = fake.calls.find((call) => call.method === "POST" && call.path === "/api/bots/pixie/tasks");
    expect(create?.body).toEqual({ title: "Firaz · linked Mac" });
    expect(fake.calls.some((call) => call.path === "/api/bots/pixie/tasks/putri-thread" && call.search === "?messages=0")).toBe(true);
    expect(fake.selected).toBe("putri-thread");
    // only ?messages=0 snapshots: Putri's transcript is never requested
    expect(fake.calls.filter((call) => call.path === "/api/bots").every((call) => call.search === "?messages=0")).toBe(true);
    expect(fake.calls.some((call) => call.path === "/api/threads/putri-thread/messages")).toBe(false);
    const everything = JSON.stringify([idle, bot, frames]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toContain(TOKEN);
    // every B call carries the link token as a bearer header, nothing else does
    expect(fake.calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const file = join(dir, "remote-bots.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN);
  });

  it("persists the thread map across restarts", async () => {
    await bridge.listBots(0);
    await firstSend();
    bridge.stop();
    const again = make();
    const [bot] = await again.listBots(0);
    expect(bot!.threadId).toBe(`rt-${KEY}-bridge-1`);
    expect(fake.created).toBe(1);
    again.stop();
  });

  it("relays only frames for bridge threads, rewritten to virtual ids", async () => {
    bridge.start();
    await until(() => fake.streams.length === 1);
    fake.push({ kind: "hello", cursor: "S:1", resumed: false });
    await until(() => frames.some((frame) => frame.kind === "bot"));
    await firstSend();
    frames = [];
    queueChanges = 0;
    const bridgeMessage = { id: "b1", role: "bot", kind: "text", text: "hi firaz", at: 2, from: { botId: "pixie", name: "Pixie" },
      comm: { fromBotId: "other", secret: SECRET }, sender: { name: "BOS multiplayer bridge" } };
    // Putri's private thread: every kind of frame must be dropped
    fake.push({ kind: "message", threadId: "putri-thread", message: { id: "p2", role: "bot", kind: "text", text: SECRET } }, "S:2");
    fake.push({ kind: "message.patch", threadId: "putri-thread", message: { id: "p2", text: SECRET } }, "S:3");
    fake.push({ kind: "thread", threadId: "putri-thread", activeLeafId: "p2" }, "S:4");
    fake.push({ kind: "runtime", event: { type: "content.delta", threadId: "putri-thread", payload: { delta: SECRET } } }, "S:5");
    fake.push({ kind: "notify", notification: { kind: "reply", botId: "pixie", botName: "Pixie", threadId: "putri-thread", title: "Pixie", body: SECRET } }, "S:6");
    fake.push({ kind: "screen", botId: "pixie", threadId: "putri-thread", png: SECRET }, "S:7");
    fake.push({ kind: "message", threadId: "group-thread", message: { id: "g1", text: SECRET } }, "S:8");
    fake.push({ kind: "config", config: { secret: SECRET } }, "S:9");
    fake.push({ kind: "bot.queued", queues: { "putri-thread": [{ queueId: "q", text: SECRET }] } }, "S:10");
    // a bot frame carries B's selected (Putri's) transcript: only display fields may pass
    fake.push({ kind: "bot", bot: { ...fake.bot(), messages: [{ id: "p3", text: SECRET }] } }, "S:11");
    // the bridge's own thread passes, rewritten
    fake.push({ kind: "message", threadId: "bridge-1", message: bridgeMessage }, "S:12");
    fake.push({ kind: "runtime", event: { type: "content.delta", threadId: "bridge-1", payload: { delta: "hi" }, raw: { secret: SECRET } } }, "S:13");
    fake.push({ kind: "notify", notification: { kind: "reply", botId: "pixie", botName: "Pixie", threadId: "bridge-1", title: "Pixie", body: "hi firaz", groupId: "g" } }, "S:14");
    fake.push({ kind: "bot.queued", queues: { "bridge-1": [{ queueId: "q2", text: "later" }], "putri-thread": [{ queueId: "q", text: SECRET }] } }, "S:15");
    await until(() => notices.length === 1 && queueChanges === 1);
    await until(() => frames.some((frame) => frame.kind === "runtime"));

    expect(JSON.stringify(frames)).not.toContain(SECRET);
    expect(JSON.stringify(notices)).not.toContain(SECRET);
    expect(JSON.stringify(bridge.queues())).not.toContain(SECRET);
    const virtualThread = `rt-${KEY}-bridge-1`;
    const message = frames.find((frame) => frame.kind === "message");
    expect(message).toMatchObject({ threadId: virtualThread, message: { id: "b1", text: "hi firaz", from: { botId } } });
    expect(message!.message.comm).toBeUndefined();
    expect(message!.message.sender).toBeUndefined();
    const runtime = frames.find((frame) => frame.kind === "runtime");
    expect(runtime!.event).toMatchObject({ threadId: virtualThread, type: "content.delta" });
    expect(runtime!.event.raw).toBeUndefined();
    const bot = frames.find((frame) => frame.kind === "bot");
    expect(bot!.bot.id).toBe(botId);
    expect(bot!.bot.messages).toBeUndefined();
    expect(bot!.bot.tasks.map((task: { threadId: string }) => task.threadId)).toEqual([virtualThread]);
    expect(notices[0]).toMatchObject({ botId, threadId: virtualThread, body: "hi firaz" });
    expect((notices[0] as { groupId?: string }).groupId).toBeUndefined();
    expect(bridge.queues()).toEqual({ [virtualThread]: [{ queueId: "q2", text: "later" }] });
    expect(frames.every((frame) => frame.kind !== "config" && frame.kind !== "screen" && frame.kind !== "thread")).toBe(true);
  });

  it("resumes with since and rehydrates what it missed when B cannot replay", async () => {
    bridge.start();
    await until(() => fake.streams.length === 1);
    fake.push({ kind: "hello", cursor: "S:1", resumed: false });
    await until(() => frames.some((frame) => frame.kind === "bot"));
    await firstSend();
    const [bot] = await bridge.listBots(50); // hydrates the bridge thread cache
    expect(bot!.messages.map((message) => message.id)).toHaveLength(1);
    fake.push({ kind: "ping" }, "S:7");
    await new Promise((resolve) => setTimeout(resolve, 20));
    // B keeps working while this home is disconnected
    fake.threads.get("bridge-1")!.push({ id: "late", role: "bot", kind: "text", text: "missed reply", at: 9 });
    fake.streams[0]!.error(new Error("network dropped"));
    await until(() => fake.streams.length === 2);
    expect(fake.streamUrls[1]!.searchParams.get("since")).toBe("S:7");
    expect(fake.streamUrls[1]!.searchParams.get("screens")).toBe("off");
    frames = [];
    fake.push({ kind: "hello", cursor: "T:1", resumed: false });
    await until(() => frames.some((frame) => frame.kind === "message"));
    expect(frames.find((frame) => frame.kind === "message")).toMatchObject({ threadId: `rt-${KEY}-bridge-1`, message: { id: "late", text: "missed reply" } });
    expect(frames.find((frame) => frame.kind === "thread")).toMatchObject({ threadId: `rt-${KEY}-bridge-1`, activeLeafId: "late" });
    expect(fake.calls.some((call) => call.path === "/api/threads/putri-thread/messages")).toBe(false);
    expect(fake.created).toBe(1);
  });

  it("re-uploads attachments with their upload id and rewrites the tags", async () => {
    const [bot] = await bridge.listBots(0);
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const docId = "223e4567-e89b-42d3-a456-426614174000";
    const attachments = join(dir, "attachments");
    await import("node:fs").then((fs) => fs.mkdirSync(attachments));
    writeFileSync(join(attachments, `${uuid}.png`), Buffer.from([137, 80, 78, 71]));
    writeFileSync(join(attachments, `${docId}.pdf`), "%PDF-1.4");
    const text = `look\n<attached-image path="${join(attachments, `${uuid}.png`)}" name="shot &amp; more.png" />\n<attached-file path="${join(attachments, `${docId}.pdf`)}" name="plan.pdf" />`;
    const answer = await route("POST", `/api/bots/${botId}/messages`, { text, threadId: bot!.threadId, sendId: "send-1" });
    expect(answer.status).toBe(200);
    const image = fake.calls.find((call) => call.path === "/api/attachments");
    expect(image?.search).toBe(`?uploadId=${uuid}`);
    expect(image?.headers["content-type"]).toBe("image/png");
    expect([...image!.raw!]).toEqual([137, 80, 78, 71]);
    const file = fake.calls.find((call) => call.path === "/api/files");
    expect(new URLSearchParams(file!.search).get("uploadId")).toBe(docId);
    expect(new URLSearchParams(file!.search).get("name")).toBe("plan.pdf");
    expect(file?.headers["content-type"]).toBe("application/pdf");
    const sent = fake.calls.find((call) => call.path === "/api/bots/pixie/messages")!.body as Record<string, string>;
    expect(sent.threadId).toBe("bridge-1");
    expect(sent.sendId).toBe("send-1");
    expect(sent.text).toBe(`look\n<attached-image path="/Users/owner/.bos-bot/attachments/${uuid}.png" name="shot &amp; more.png" />\n<attached-file path="/Users/owner/.bos-bot/attachments/${docId}.pdf" name="plan.pdf" />`);
    const body = jsonOf(answer);
    expect(body.threadId).toBe(`rt-${KEY}-bridge-1`);
    expect(body.bot.id).toBe(botId);
    expect(JSON.stringify(body)).not.toContain(SECRET);
    // a path outside this home's attachment directory is never read or sent
    const outside = await route("POST", `/api/bots/${botId}/messages`, { text: `<attached-file path="${join(dir, "placeholder")}" name="x" />` });
    expect(outside.status).toBe(400);
  });

  it("deduplicates concurrent retries of one sendId", async () => {
    await bridge.listBots(0);
    const [a, b] = await Promise.all([
      route("POST", `/api/bots/${botId}/messages`, { text: "hello", sendId: "same" }),
      route("POST", `/api/bots/${botId}/messages`, { text: "hello", sendId: "same" }),
    ]);
    expect(a.status).toBe(200);
    expect(jsonOf(a)).toEqual(jsonOf(b));
    expect(fake.calls.filter((call) => call.path === "/api/bots/pixie/messages")).toHaveLength(1);
  });

  it("injects the bridge thread into interrupt and refuses Putri's thread ids", async () => {
    await bridge.listBots(0);
    // no bridge thread yet: nothing to stop, and nothing is opened on B
    expect(jsonOf(await route("POST", `/api/bots/${botId}/interrupt`, { threadId: pending }))).toEqual({ ok: true });
    expect(fake.calls.some((call) => call.path === "/api/bots/pixie/interrupt")).toBe(false);
    expect(taskCreates()).toBe(0);
    await firstSend();
    const answer = await route("POST", `/api/bots/${botId}/interrupt`, {});
    expect(answer.status).toBe(200);
    expect(fake.calls.find((call) => call.path === "/api/bots/pixie/interrupt")!.body).toEqual({ threadId: "bridge-1" });
    expect(jsonOf(answer)).toEqual({ ok: true, threadId: `rt-${KEY}-bridge-1`, stopped: true });
    const guessed = await route("POST", `/api/bots/${botId}/interrupt`, { threadId: `rt-${KEY}-putri-thread` });
    expect(guessed.status).toBe(404);
    expect((await route("GET", `/api/threads/rt-${KEY}-putri-thread/messages`)).status).toBe(404);
    expect((await route("POST", `/api/bots/${botId}/tasks/rt-${KEY}-putri-thread`)).status).toBe(404);
    expect(fake.calls.filter((call) => call.path.includes("putri-thread") && call.search !== "?messages=0")).toHaveLength(0);
  });

  it("answers 403 for routes a bot on another Mac cannot serve", async () => {
    await bridge.listBots(0);
    await firstSend();
    for (const [method, path, search] of [
      ["POST", `/api/bots/${botId}/messages/guarded`, ""],
      ["POST", `/api/bots/${botId}/queue/q1/steer`, ""],
      ["POST", `/api/bots/${botId}/always-allow`, ""],
      ["GET", `/api/bots/${botId}/memory`, ""],
      ["GET", `/api/bots/${botId}/export`, ""],
      ["DELETE", `/api/bots/${botId}`, ""],
      ["PATCH", `/api/bots/${botId}`, ""],
      ["GET", `/api/threads/rt-${KEY}-bridge-1/export`, ""],
    ] as const) {
      const answer = await bridge.route(method, path, new URLSearchParams(search), async () => ({ soul: "x" }));
      expect(answer, `${method} ${path}`).toEqual({ status: 403, json: { error: REMOTE_BOT_UNAVAILABLE } });
    }
    // pinning stays on this home
    const pinned = await route("PATCH", `/api/bots/${botId}`, { pinned: true });
    expect(jsonOf(pinned).bot.pinned).toBe(true);
    expect(fake.calls.some((call) => call.method === "PATCH" && call.path === "/api/bots/pixie")).toBe(false);
  });

  it("makes no thread on B when connecting, reconnecting, or when a new bot appears", async () => {
    await bridge.listBots(50);
    bridge.start();
    await until(() => fake.streams.length === 1);
    fake.push({ kind: "hello", cursor: "S:1", resumed: false });
    await until(() => frames.some((frame) => frame.kind === "bot"));
    fake.extraBots.push({ ...fake.bot(), id: "nova", name: "Nova", tasks: [], threadId: "nova-own" });
    fake.push({ kind: "bot", bot: fake.extraBots[0]! }, "S:2");
    await until(() => frames.some((frame) => frame.kind === "bot" && frame.bot.id === `rb-${KEY}-nova`));
    fake.streams[0]!.error(new Error("network dropped"));
    await until(() => fake.streams.length === 2);
    frames = [];
    fake.push({ kind: "hello", cursor: "T:1", resumed: false });
    await until(() => frames.filter((frame) => frame.kind === "bot").length >= 2);
    const bots = await bridge.listBots(50);
    expect(bots.map((bot) => bot.threadId).sort()).toEqual([pending, `rt-${KEY}-pending-nova`].sort());
    expect(fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/tasks"))).toHaveLength(0);
    expect(fake.calls.every((call) => call.method === "GET")).toBe(true);
    expect(fake.selected).toBe("putri-thread");
  });

  it("resets a bridge thread to Ask with no standing grants before using it", async () => {
    await bridge.listBots(0);
    await firstSend();
    const reset = fake.calls.find((call) => call.method === "PATCH" && call.path === "/api/bots/pixie/tasks/bridge-1");
    expect(reset?.body).toEqual({ modelSelection: { instanceId: "claude", model: "opus" }, resetApprovalToAsk: true });
    const order = fake.calls.map((call) => `${call.method} ${call.path}`);
    expect(order.indexOf("PATCH /api/bots/pixie/tasks/bridge-1")).toBeLessThan(order.indexOf("POST /api/bots/pixie/messages"));
    expect(fake.tasks.find((task) => task.threadId === "bridge-1")).toMatchObject({ approvalMode: "ask", autoApprove: false });
    const [bot] = await bridge.listBots(0);
    expect(bot!.approvalMode).toBe("ask");
    expect(bot!.autoApprove).toBe(false);
  });

  it("refuses to use a thread B will not put on Ask, and removes it", async () => {
    fake.customApproval = true;
    await bridge.listBots(0);
    const answer = await route("POST", `/api/bots/${botId}/messages`, { text: "hi", threadId: pending });
    expect(answer.status).toBe(409);
    expect(fake.calls.some((call) => call.path === "/api/bots/pixie/messages")).toBe(false);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path === "/api/bots/pixie/tasks/bridge-1")).toBe(true);
    expect(fake.tasks.map((task) => task.threadId)).toEqual(["putri-thread"]);
    expect(fake.selected).toBe("putri-thread");
    const [bot] = await bridge.listBots(0);
    expect(bot!.threadId).toBe(pending);
    expect(bot!.tasks).toEqual([]);
  });

  it("passes one-off answers but never a standing grant", async () => {
    await bridge.listBots(0);
    await firstSend();
    const always = await route("POST", `/api/bots/${botId}/respond`, { requestId: "r1", behavior: "allow", always: true });
    expect(always).toEqual({ status: 403, json: { error: REMOTE_BOT_UNAVAILABLE } });
    const threadAlways = await route("POST", `/api/threads/rt-${KEY}-bridge-1/respond`, { requestId: "r1", behavior: "allow", always: true });
    expect(threadAlways.status).toBe(403);
    expect((await route("POST", `/api/bots/${botId}/always-allow`, { tool: "Bash" })).status).toBe(403);
    const once = await route("POST", `/api/bots/${botId}/respond`, { requestId: "r1", behavior: "allow", always: false, extra: "x" });
    expect(once.status).toBe(200);
    expect(fake.calls.find((call) => call.path === "/api/bots/pixie/respond")!.body).toEqual({ requestId: "r1", behavior: "allow", threadId: "bridge-1" });
    expect((await route("POST", `/api/threads/rt-${KEY}-bridge-1/respond`, { requestId: "r2", behavior: "deny", message: "no" })).status).toBe(200);
    expect(fake.calls.find((call) => call.path === "/api/threads/bridge-1/respond")!.body).toEqual({ requestId: "r2", behavior: "deny", message: "no" });
    expect(fake.calls.some((call) => call.path.endsWith("/always-allow"))).toBe(false);
  });

  it("never re-bridges a bot the other Mac relays itself", async () => {
    const original = fake.fetcher;
    fake.fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/bots") {
        return new Response(JSON.stringify({ bots: [
          { ...fake.bot(), id: `rb-${homeKey("home-firaz")}-mine`, remote: { homeId: "home-firaz" } },
        ] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return original(input, init);
    }) as typeof fetch;
    bridge = make();
    expect(await bridge.listBots(0)).toEqual([]);
    expect(fake.created).toBe(0);
  });
});
