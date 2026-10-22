import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { initialOnboardingState, type OnboardingChatMessage, type OnboardingChatState } from "../shared/onboarding-chat.ts";
import { applyOnboardingChatEvent, parseOnboardingChatEvent, type OnboardingChatHost } from "./onboarding-chat.ts";

type Fixture = Awaited<ReturnType<typeof launchVerificationServer>>;

function client(fixture: Fixture) {
  return async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    return { status: response.status, body: await response.json() as any };
  };
}

const onboardingLines = (rows: any[]) => rows.filter((row) => row.onboarding).map((row) => row.onboarding as OnboardingChatMessage);
const lineKey = (line: OnboardingChatMessage) => `${line.step}|${line.text}|${line.card?.kind ?? ""}|${line.card?.kind === "connect" ? line.card.app : ""}`;

it("walks a fresh workspace from start to first task, posting each scripted line once", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(["On it."]), FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const api = client(fixture);
  const event = (value: unknown) => api("POST", "/api/onboarding/chat", { event: value });
  try {
    expect((await api("PUT", "/api/config", { profile: { name: "Ada Lovelace" } })).status).toBe(200);
    // the splash shows until the person starts, so no record exists before
    expect((await api("GET", "/api/config")).body.onboarding.chat).toBeUndefined();
    expect((await event({ type: "name", value: "Early" })).status).toBe(409);
    expect((await event({ type: "dance" })).status).toBe(400);
    expect((await event({ type: "connected", app: "slack" })).status).toBe(400);
    expect((await api("POST", "/api/onboarding/chat", { nope: true })).status).toBe(400);
    expect((await api("PUT", "/api/config", { onboarding: { chat: { step: "done" } } })).status).toBe(400);

    const started = await event({ type: "start" });
    expect(started.status).toBe(200);
    let state: OnboardingChatState = started.body.state;
    expect(state).toMatchObject({ botName: "BOS", connected: [] });
    expect(["engine", "done"]).toContain(state.step);
    expect((await api("GET", "/api/config")).body.onboarding.chat).toEqual(state);
    const thread = () => api("GET", `/api/threads/${state.threadId}/messages`).then((r) => r.body.messages as any[]);
    const opening = await thread();
    // one greeting with the starter jobs, and the sign-in only when no engine can run
    const lines = onboardingLines(opening);
    expect(lines[0]).toMatchObject({ step: "greet", card: { kind: "suggestions" } });
    expect(lines[0].text).toContain("Hi Ada, I'm BOS");
    expect(lines.map((line) => line.step)).toEqual(state.step === "engine" ? ["greet", "engine"] : ["greet"]);
    // the first-run seed greeting is taken over, not left above the new one
    expect(opening.some((row) => row.text?.startsWith("I'm BOS, your first AI teammate"))).toBe(false);
    expect(opening.every((row) => row.onboarding)).toBe(true);
    expect((await event({ type: "start" })).body.state).toEqual(state);
    expect((await event({ type: "name", value: "Other" })).body.state).toEqual(state);
    if (state.step === "engine") state = (await event({ type: "engine-ready" })).body.state;
    expect(state.step).toBe("done");

    const before = onboardingLines(await thread());
    // each line exactly once
    expect(new Set(before.map(lineKey)).size).toBe(before.length);

    const sent = await api("POST", `/api/bots/${state.botId}/messages`, { text: "Summarise my inbox", threadId: state.threadId });
    expect(sent.status).toBeLessThan(300);
    await expect.poll(async () => (await api("GET", "/api/config")).body.onboarding.chat.step, { timeout: 10000, interval: 100 }).toBe("done");
    const done = (await api("GET", "/api/config")).body.onboarding.chat as OnboardingChatState;
    expect(done.completedAt).toBeTruthy();
    // the bot answers the prompt as a normal turn
    await expect.poll(async () => (await thread()).some((row) => row.role === "bot" && !row.onboarding && row.text.includes("On it.")), { timeout: 15000, interval: 100 }).toBe(true);
    expect(onboardingLines(await thread())).toHaveLength(before.length);
    for (const replay of [{ type: "start" }, { type: "name", value: "Again" }, { type: "connected", app: "outlook" }, { type: "skip" }]) {
      expect((await event(replay)).body.state).toEqual(done);
    }
    expect(onboardingLines(await thread())).toHaveLength(before.length);
  } finally { await fixture.close(); }
}, 40000);

it("a prepared greeting puts bos back above the teammates hired after it", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: "[]", FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const api = client(fixture);
  try {
    const started = await api("POST", "/api/onboarding/chat", { event: { type: "start" } });
    expect(started.status).toBe(200);
    const { botId } = started.body.state as OnboardingChatState;
    expect((await api("POST", "/api/bots", { name: "Nadia", title: "Finds new corporate catering leads." })).status).toBe(201);
    expect((await api("GET", "/api/bots?messages=0")).body.bots[0].name).toBe("Nadia");
    const prepared = { type: "prepared", profile: [{ label: "Business", value: "Kedai Kopi Test" }], team: [{ name: "Nadia", job: "Finds new corporate catering leads." }] };
    expect((await api("POST", "/api/onboarding/chat", { event: prepared })).status).toBe(200);
    const bots = (await api("GET", "/api/bots?messages=0")).body.bots;
    expect(bots[0].id).toBe(botId);
    expect(bots.map((bot: { name: string }) => bot.name)).toContain("Nadia");
  } finally { await fixture.close(); }
});

describe("applyOnboardingChatEvent", () => {
  function memoryHost(personName = "Ada") {
    const rows: { id: string; onboarding?: OnboardingChatMessage }[] = [];
    const saved: OnboardingChatState[] = [];
    const led: string[] = [];
    const host: OnboardingChatHost = {
      personName,
      lead: (threadId) => { led.push(threadId); },
      messages: () => rows,
      append: (_thread, line) => { rows.push({ id: `m${rows.length}`, onboarding: line }); },
      patch: (_thread, id, line) => { const row = rows.find((r) => r.id === id); if (row) row.onboarding = line; },
      save: (state) => { saved.push(state); },
    };
    return { host, rows, saved, led };
  }

  it("posts the engine card only when no engine is ready, and never twice", () => {
    const { host, rows } = memoryHost();
    let state = initialOnboardingState("b1", "t1", "BOS", false);
    state = applyOnboardingChatEvent(host, state, { type: "start" });
    expect(state.step).toBe("engine");
    expect(rows.map((r) => r.onboarding?.step)).toEqual(["greet", "engine"]);
    state = applyOnboardingChatEvent(host, state, { type: "engine-ready" });
    expect(state.step).toBe("done");
    const count = rows.length;
    state = applyOnboardingChatEvent(host, state, { type: "engine-ready" });
    expect(rows).toHaveLength(count);
  });

  it("with an engine ready, posts one greeting and ends setup", () => {
    const { host, rows } = memoryHost();
    const state = applyOnboardingChatEvent(host, initialOnboardingState("b1", "t1", "BOS", true), { type: "start" });
    expect(rows.map((r) => r.onboarding?.step)).toEqual(["greet"]);
    expect(state.step).toBe("done");
    expect(applyOnboardingChatEvent(host, state, { type: "start" })).toBe(state);
    expect(rows).toHaveLength(1);
  });

  it("does not save an unchanged record", () => {
    const { host, saved } = memoryHost();
    const state = initialOnboardingState("b1", "t1", "BOS", true);
    expect(applyOnboardingChatEvent(host, state, { type: "connected", app: "gmail" }).connected).toEqual(["gmail"]);
    expect(saved).toHaveLength(1);
    const done = { ...state, step: "done" as const, completedAt: "x" };
    expect(applyOnboardingChatEvent(host, done, { type: "start" })).toBe(done);
    expect(saved).toHaveLength(1);
  });

  const prepared = {
    type: "prepared" as const,
    profile: [{ label: "Business", value: "Kedai Kopi Test, a cafe in Bangsar" }, { label: "Price", value: "" }],
    team: [{ name: "Nadia", job: "Finds new corporate catering leads." }],
    firstJob: { title: "Find 10 catering leads", prompt: "Find 10 offices near Bangsar that order catering." },
  };

  it("rewrites the greeting with the prepared business, team and first job, without moving the steps", () => {
    const { host, rows, saved } = memoryHost();
    let state = applyOnboardingChatEvent(host, initialOnboardingState("b1", "t1", "BOS", false), { type: "start" });
    const count = rows.length;
    const savedCount = saved.length;
    expect(applyOnboardingChatEvent(host, state, prepared)).toBe(state);
    expect(rows).toHaveLength(count);
    expect(saved).toHaveLength(savedCount);
    const greet = rows[0].onboarding!;
    expect(greet.step).toBe("greet");
    expect(greet.text).toContain("Hi Ada");
    expect(greet.text).toContain("- Business: Kedai Kopi Test, a cafe in Bangsar");
    expect(greet.text).not.toContain("Price");
    expect(greet.text).toContain("Nadia (Finds new corporate catering leads)");
    expect(greet.card?.kind === "suggestions" && greet.card.items[0]).toEqual({ id: "prepared", ...prepared.firstJob });
    // a retry rewrites the same line, never a second greeting
    state = applyOnboardingChatEvent(host, state, prepared);
    expect(rows).toHaveLength(count);
  });

  it("puts bos first in the roster when the greeting is prepared, never once the person has written", () => {
    const { host, rows, led } = memoryHost();
    const state = applyOnboardingChatEvent(host, initialOnboardingState("b1", "t1", "BOS", false), { type: "start" });
    expect(led).toEqual([]);
    applyOnboardingChatEvent(host, state, prepared);
    expect(led).toEqual(["t1"]);
    (rows as { id: string; role?: string }[]).push({ id: "u1", role: "user" });
    applyOnboardingChatEvent(host, state, prepared);
    expect(led).toEqual(["t1"]);
  });

  it("posts the prepared greeting before start, and start does not greet twice", () => {
    const { host, rows } = memoryHost();
    let state = applyOnboardingChatEvent(host, initialOnboardingState("b1", "t1", "BOS", false), prepared);
    expect(rows.map((r) => r.onboarding?.step)).toEqual(["greet"]);
    state = applyOnboardingChatEvent(host, state, { type: "start" });
    expect(rows.map((r) => r.onboarding?.step)).toEqual(["greet", "engine"]);
    expect(rows[0].onboarding?.text).toContain("read up on your business");
  });

  it("leaves the greeting alone once the person has written", () => {
    const { host, rows } = memoryHost();
    const state = applyOnboardingChatEvent(host, initialOnboardingState("b1", "t1", "BOS", false), { type: "start" });
    (rows as { id: string; role?: string }[]).push({ id: "u1", role: "user" });
    const before = rows[0].onboarding;
    applyOnboardingChatEvent(host, state, prepared);
    expect(rows[0].onboarding).toBe(before);
  });

  it("refuses unknown and malformed events", () => {
    expect(parseOnboardingChatEvent({ type: "dance" })).toMatchObject({ ok: false, error: expect.stringContaining("dance") });
    expect(parseOnboardingChatEvent({ type: "connected", app: "slack" }).ok).toBe(false);
    expect(parseOnboardingChatEvent({ type: "start", extra: 1 }).ok).toBe(false);
    expect(parseOnboardingChatEvent({ type: "first-task", prompt: "hi" })).toEqual({ ok: true, event: { type: "first-task", prompt: "hi" } });
    expect(parseOnboardingChatEvent(prepared).ok).toBe(true);
    expect(parseOnboardingChatEvent({ ...prepared, team: [{ name: "", job: "x" }] }).ok).toBe(false);
    expect(parseOnboardingChatEvent({ ...prepared, extra: 1 }).ok).toBe(false);
  });
});
