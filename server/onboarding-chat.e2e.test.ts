import { describe, expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { initialOnboardingState, onboardingScript, type OnboardingChatMessage, type OnboardingChatState } from "../shared/onboarding-chat.ts";
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
    expect(state).toMatchObject({ step: "name", botName: "BOS", connected: [], completedAt: "" });
    expect((await api("GET", "/api/config")).body.onboarding.chat).toEqual(state);
    const thread = () => api("GET", `/api/threads/${state.threadId}/messages`).then((r) => r.body.messages as any[]);
    const ctx = () => ({ personName: "Ada Lovelace", botName: state.botName, engineReady: state.engineReady, connected: state.connected });
    expect(onboardingLines(await thread()).map(lineKey)).toEqual([...onboardingScript("greet", ctx()), ...onboardingScript("name", ctx())].map(lineKey));
    expect((await event({ type: "start" })).body.state).toEqual(state);

    state = (await event({ type: "name", value: "  Jarvis  " })).body.state;
    expect(state.botName).toBe("Jarvis");
    expect((await api("GET", "/api/bots")).body.bots.find((bot: any) => bot.id === state.botId).name).toBe("Jarvis");
    if (state.step === "engine") state = (await event({ type: "engine-ready" })).body.state;
    expect(state.step).toBe("apps");
    expect((await event({ type: "name", value: "Other" })).body.state).toEqual(state);
    const nameCard = onboardingLines(await thread()).find((line) => line.card?.kind === "name-input");
    expect(nameCard?.card).toMatchObject({ kind: "name-input", value: "Jarvis", submitted: true });

    state = (await event({ type: "connected", app: "gmail" })).body.state;
    expect(state).toMatchObject({ step: "first-task", connected: ["gmail"] });
    expect((await event({ type: "connected", app: "gmail" })).body.state).toEqual(state);
    const gmailCard = onboardingLines(await thread()).find((line) => line.card?.kind === "connect" && line.card.app === "gmail");
    expect(gmailCard?.card).toMatchObject({ connected: true });

    const before = onboardingLines(await thread());
    const steps = new Set(before.map((line) => line.step));
    expect([...steps]).toEqual(["greet", "name", "about", ...(steps.has("engine") ? ["engine"] : []), "apps", "first-task"]);
    for (const step of steps) {
      const expected = onboardingScript(step, { ...ctx(), connected: [] }).length;
      expect(before.filter((line) => line.step === step)).toHaveLength(expected);
    }
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

it("treats early typing as the first task and posts nothing after it", async () => {
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_REPLIES: JSON.stringify(["Sure."]), FAKE_CLAUDE_TOOL_CALLS: "[]" });
  const api = client(fixture);
  try {
    const state: OnboardingChatState = (await api("POST", "/api/onboarding/chat", { event: { type: "start" } })).body.state;
    expect(state.step).toBe("name");
    const thread = () => api("GET", `/api/threads/${state.threadId}/messages`).then((r) => r.body.messages as any[]);
    const lines = onboardingLines(await thread());
    expect(lines.map((line) => line.step)).toEqual(["greet", "name"]);
    expect((await api("POST", `/api/bots/${state.botId}/messages`, { text: "book me a dentist", threadId: state.threadId })).status).toBeLessThan(300);
    await expect.poll(async () => (await api("GET", "/api/config")).body.onboarding.chat.step, { timeout: 10000, interval: 100 }).toBe("done");
    await expect.poll(async () => (await thread()).some((row) => row.role === "bot" && row.text.includes("Sure.")), { timeout: 15000, interval: 100 }).toBe(true);
    expect(onboardingLines(await thread())).toHaveLength(lines.length);
    expect((await api("POST", "/api/onboarding/chat", { event: { type: "name", value: "Late" } })).body.state.step).toBe("done");
    expect(onboardingLines(await thread())).toHaveLength(lines.length);
  } finally { await fixture.close(); }
}, 40000);

describe("applyOnboardingChatEvent", () => {
  function memoryHost(personName = "Ada") {
    const rows: { id: string; onboarding?: OnboardingChatMessage }[] = [];
    const saved: OnboardingChatState[] = [];
    const host: OnboardingChatHost = {
      personName,
      messages: () => rows,
      append: (_thread, line) => { rows.push({ id: `m${rows.length}`, onboarding: line }); },
      patch: (_thread, id, line) => { const row = rows.find((r) => r.id === id); if (row) row.onboarding = line; },
      save: (state) => { saved.push(state); },
    };
    return { host, rows, saved };
  }

  it("posts the engine card only when no engine is ready, and never twice", () => {
    const { host, rows } = memoryHost();
    let state = initialOnboardingState("b1", "t1", "BOS", false);
    state = applyOnboardingChatEvent(host, state, { type: "start" });
    state = applyOnboardingChatEvent(host, state, { type: "name", value: "Max" });
    expect(state.step).toBe("engine");
    expect(rows.filter((r) => r.onboarding?.step === "engine")).toHaveLength(1);
    state = applyOnboardingChatEvent(host, state, { type: "engine-ready" });
    expect(state.step).toBe("apps");
    const count = rows.length;
    state = applyOnboardingChatEvent(host, state, { type: "engine-ready" });
    expect(rows).toHaveLength(count);
  });

  it("skipping the name walks past about without a second about", () => {
    const { host, rows } = memoryHost();
    let state = applyOnboardingChatEvent(host, initialOnboardingState("b1", "t1", "BOS", true), { type: "start" });
    state = applyOnboardingChatEvent(host, state, { type: "skip" });
    expect(state.step).toBe("apps");
    expect(rows.map((r) => r.onboarding?.step)).toEqual(["greet", "name", "about", "about", "apps", "apps", "apps"]);
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

  it("refuses unknown and malformed events", () => {
    expect(parseOnboardingChatEvent({ type: "dance" })).toMatchObject({ ok: false, error: expect.stringContaining("dance") });
    expect(parseOnboardingChatEvent({ type: "connected", app: "slack" }).ok).toBe(false);
    expect(parseOnboardingChatEvent({ type: "start", extra: 1 }).ok).toBe(false);
    expect(parseOnboardingChatEvent({ type: "first-task", prompt: "hi" })).toEqual({ ok: true, event: { type: "first-task", prompt: "hi" } });
  });
});
