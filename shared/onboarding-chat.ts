// 2.0 onboarding happens inside the first bot's conversation, not in a
// modal flow. The bot greets the person, asks what to call it, says what it
// can do, and offers inline cards (engine sign-in, app connections, first
// task). Every client renders the same messages, so this module is the one
// contract the server, the desktop app and the phone share: the steps, the
// cards each step carries, the copy, and the pure transition between steps.
//
// Frozen names (2026-10-08): OnboardingChatStep, OnboardingCard,
// OnboardingChatMessage, OnboardingChatState, OnboardingChatEvent,
// onboardingScript, nextOnboardingState, ONBOARDING_CHAT_VERSION,
// ONBOARDING_APPS. Change them only by a new version.

export const ONBOARDING_CHAT_VERSION = 2;

export type OnboardingChatStep = "greet" | "name" | "about" | "engine" | "apps" | "first-task" | "done";

/** App connections offered inline. ids are the connector ids the server already uses. */
export const ONBOARDING_APPS = [
  { id: "gmail", name: "Gmail", blurb: "Search, read and draft email" },
  { id: "outlook", name: "Outlook", blurb: "Search, read and draft Microsoft email" },
  { id: "googlecalendar", name: "Google Calendar", blurb: "See and plan your schedule" },
] as const;
export type OnboardingAppId = typeof ONBOARDING_APPS[number]["id"];

export type OnboardingCard =
  | { kind: "name-input"; value: string; submitted: boolean }
  | { kind: "engine" }
  | { kind: "connect"; app: OnboardingAppId; connected: boolean }
  | { kind: "suggestions"; items: { id: string; title: string; prompt: string }[] };

/** What the server appends as `onboarding` on a bot message in the first thread. */
export interface OnboardingChatMessage {
  step: OnboardingChatStep;
  text: string;
  card?: OnboardingCard;
}

/** Stored in workspace config as `onboarding.chat`. */
export interface OnboardingChatState {
  version: number;
  botId: string;
  threadId: string;
  step: OnboardingChatStep;
  botName: string;
  engineReady: boolean;
  connected: OnboardingAppId[];
  completedAt: string;
}

export type OnboardingChatEvent =
  | { type: "start" }
  | { type: "name"; value: string }
  | { type: "engine-ready" }
  | { type: "connected"; app: OnboardingAppId }
  | { type: "skip" }
  | { type: "first-task"; prompt: string }
  | ({ type: "prepared" } & OnboardingPrepared);

/** What was researched about the person's business before they signed up
 * (a prepared invite link). The greeting shows it back to them, with their
 * team and the first job, so they can correct it before anything runs. */
export interface OnboardingPrepared {
  /** How bos knows: absent for a prepared invite (researched before they
   * arrived), "read" when it just read their page, "told" when they answered
   * two questions (the 60-second start, server/faststart.ts). */
  intro?: "read" | "told";
  profile: { label: string; value: string }[];
  team: { name: string; job: string }[];
  firstJob?: { title: string; prompt: string };
}

/** Starter taps begin with a draft or with a reviewed connection step when
 * the job needs an app. They never authorize account linking or scheduling. */
export const FIRST_TASKS = [
  { id: "whatsapp-work-groups", title: "Summarise my work groups every morning", prompt: "Help me summarise my WhatsApp work groups every morning. First let me choose which groups to link and read. Draft one sample summary, then let me review the schedule, time zone and delivery destination before enabling a routine. Do not link accounts, read groups or schedule anything without my approval." },
  { id: "inbox", title: "Find what needs me in my inbox", prompt: "Look through my recent email and tell me the three things that need me most. Draft replies, but don't send anything." },
  { id: "meeting", title: "Prep me for a meeting", prompt: "Help me prepare for my next meeting. Look at my calendar first and pick the next real meeting, then give me a one-page brief: who's in it, what they care about, and three things to ask. If the meeting isn't on a calendar you can see, tell me exactly where to connect the right one, and in the same message ask who it's with." },
  { id: "summarise", title: "Summarise a document", prompt: "I want to summarise a document. Ask me to attach it, then give me the key points, the numbers that matter and anything I need to act on." },
  { id: "site", title: "Make a website for my business", prompt: "Ask me two quick questions about my business, then build an editable website preview." },
] as const;

const cleanName = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 40);

export interface OnboardingScriptContext {
  personName: string;
  botName: string;
  engineReady: boolean;
  connected: readonly OnboardingAppId[];
  /** Connected apps need a Composio project or broker. Without one the
   * apps step says what to do next instead of offering cards that can't work. */
  appsAvailable?: boolean;
  /** A configured empty array deliberately hides starter taps. */
  starterJobs?: readonly { id: string; title: string; prompt: string }[];
  freeEngine?: boolean;
}

/** The messages a step posts, in order. The first message is one short
 * greeting plus the jobs people hand over first, as taps; the engine sign-in
 * follows only when no engine can run yet. Apps connect when a job needs
 * them, not up front. Product copy, not the bot's own voice. */
export function onboardingScript(step: OnboardingChatStep, ctx: OnboardingScriptContext): OnboardingChatMessage[] {
  const person = ctx.personName.trim().split(/\s+/)[0] ?? "";
  switch (step) {
    case "greet":
      return [{
        step,
        text: `Hi${person ? ` ${person}` : ""}, I'm ${ctx.botName}, your AI teammate. Tell me what you need, or tap a job below. Nothing goes out without your OK.`,
        card: { kind: "suggestions", items: (ctx.starterJobs ?? FIRST_TASKS).map(task => ({ ...task })) },
      }];
    case "name":
      return [{ step, text: "What would you like to call me? You can change this later.", card: { kind: "name-input", value: ctx.botName, submitted: false } }];
    case "about":
      return [
        { step, text: `${ctx.botName} it is. Nice to meet you${person ? `, ${person}` : ""}.` },
      ];
    case "engine":
      return ctx.engineReady ? [] : [{ step, text: ctx.freeEngine === false
        ? "Connect the Claude or ChatGPT account you already have to get started. Your login stays on your BOS."
        : "Turn on BOS AI below to start free, no sign-in needed. Already pay for Claude or ChatGPT? Connect it instead. Your login stays on your BOS.", card: { kind: "engine" } }];
    case "apps":
      if (ctx.appsAvailable === false) {
        return [{ step, text: "I'm ready. Pick a job above or tell me what you need, and I'll get started." }];
      }
      return [
        { step, text: "I'm ready. Connect your email and I'll start with what needs you most. I only draft, nothing gets sent without your OK. Or pick a job above." },
        ...ONBOARDING_APPS.filter(app => app.id !== "googlecalendar").map(app => ({ step, text: "", card: { kind: "connect" as const, app: app.id, connected: ctx.connected.includes(app.id) } })),
      ];
    case "first-task":
      return [{ step, text: "Pick one to start, or type anything.", card: { kind: "suggestions", items: (ctx.starterJobs ?? FIRST_TASKS).map(task => ({ ...task })) } }];
    case "done":
      return [];
  }
}

/** The greeting for a prepared workspace: what bos already knows about the
 * business, the team set up for it, and its first job as the first tap. */
export function preparedGreeting(ctx: Pick<OnboardingScriptContext, "personName" | "botName" | "starterJobs">, prepared: OnboardingPrepared): OnboardingChatMessage {
  const person = ctx.personName.trim().split(/\s+/)[0] ?? "";
  const facts = prepared.profile.filter(item => item.value.trim()).map(item => `- ${item.label}: ${item.value.trim()}`).join("\n");
  const team = prepared.team.map(bot => `${bot.name} (${bot.job.trim().replace(/\.$/, "")})`).join(", ");
  const text = [
    `Hi${person ? ` ${person}` : ""}, I'm ${ctx.botName}, your own AI teammate. ${prepared.intro === "read" ? "I just read up on your business." : prepared.intro === "told" ? "Thanks, that's enough to start." : "Before you got here I read up on your business."} Here's what I have:`,
    facts,
    "If anything's off, tell me and I'll fix it.",
    team ? `Your team is set up and ready: ${team}.` : "",
    prepared.firstJob ? `Your first job is below. Tap it and I'll start. Nothing goes out to anyone unless you say so.` : "Tap a job below, or tell me in your own words. Nothing goes out to anyone unless you say so.",
  ].filter(Boolean).join("\n\n");
  const items = [...(prepared.firstJob ? [{ id: "prepared", ...prepared.firstJob }] : []), ...(ctx.starterJobs ?? FIRST_TASKS).map(task => ({ ...task }))];
  return { step: "greet", text, card: { kind: "suggestions", items } };
}

export function initialOnboardingState(botId: string, threadId: string, botName: string, engineReady: boolean): OnboardingChatState {
  return { version: ONBOARDING_CHAT_VERSION, botId, threadId, step: "greet", botName, engineReady, connected: [], completedAt: "" };
}

/** Pure step machine. Unknown or out-of-order events leave the state unchanged,
 * so a retried tap is harmless. Anything the person types once an engine can
 * run is a first-task event: they never have to finish setup to get work done. */
export function nextOnboardingState(state: OnboardingChatState, event: OnboardingChatEvent, now: () => Date = () => new Date()): OnboardingChatState {
  if (state.step === "done") return state;
  const after = (step: OnboardingChatStep): OnboardingChatStep =>
    step === "greet" ? "name"
    : step === "name" ? "about"
    : step === "about" ? (state.engineReady ? "done" : "engine")
    // the greeting already offers the starter jobs, so nothing else is asked
    : "done";
  const finish = (next: OnboardingChatState): OnboardingChatState =>
    next.step === "done" ? { ...next, completedAt: now().toISOString() } : next;
  switch (event.type) {
    // the greeting carries its own starter jobs, so start ends setup unless
    // the person must sign in first
    case "start": return state.step === "greet" ? (state.engineReady ? finish({ ...state, step: "done" }) : { ...state, step: "engine" }) : state;
    case "name": {
      const botName = cleanName(event.value);
      if (state.step !== "name" || !botName) return state;
      return finish({ ...state, botName, step: state.engineReady ? "done" : "engine" });
    }
    case "engine-ready":
      return finish({ ...state, engineReady: true, step: state.step === "engine" ? "done" : state.step });
    // a connection resumes the bot on that app, which is the first task
    case "connected":
      return state.connected.includes(event.app) ? state
        : finish({ ...state, connected: [...state.connected, event.app], step: state.step === "apps" ? "done" : state.step });
    case "skip":
      return finish({ ...state, step: after(state.step) });
    // a message sent before any engine can run is answered after sign-in,
    // so setup stays open at the sign-in card until then
    case "first-task":
      return event.prompt.trim() && state.engineReady ? finish({ ...state, step: "done" }) : state;
    // only rewrites the greeting; the steps stay where they are
    case "prepared":
      return state;
  }
}
