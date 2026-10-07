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
  | { type: "first-task"; prompt: string };

export const FIRST_TASKS = [
  { id: "inbox", title: "Find what needs me in my inbox", prompt: "Look through my recent email and tell me the three things that need me most. Draft replies, but don't send anything." },
  { id: "week", title: "Plan my week", prompt: "Look at my calendar for this week and suggest how to protect time for my most important work." },
  { id: "site", title: "Make a website for my business", prompt: "Ask me two quick questions about my business, then build an editable website preview." },
] as const;

const cleanName = (value: string) => value.replace(/\s+/g, " ").trim().slice(0, 40);

/** The messages a step posts, in order. "greet" and "about" are message-only:
 * the server posts greet + name together on start, and about + the next card
 * together once the name is in. Product copy, not the bot's own voice. */
export function onboardingScript(step: OnboardingChatStep, ctx: { personName: string; botName: string; engineReady: boolean; connected: readonly OnboardingAppId[] }): OnboardingChatMessage[] {
  const person = ctx.personName.trim().split(/\s+/)[0] || "there";
  switch (step) {
    case "greet":
      return [{ step, text: `Hi ${person}, I'm ${ctx.botName}. I can help with your work and everyday life, and take things off your plate.` }];
    case "name":
      return [{ step, text: "What would you like to call me? You can change this later.", card: { kind: "name-input", value: ctx.botName, submitted: false } }];
    case "about":
      return [
        { step, text: `${ctx.botName} it is. Nice to meet you, ${person}.` },
        { step, text: "A little about me:\n\n- I keep working while you're away, on my own computer.\n- I connect to your apps, like email and calendar, and use them the way you do.\n- I can bring in teammates for bigger jobs, and you see all of it." },
      ];
    case "engine":
      return ctx.engineReady ? [] : [{ step, text: "First I need a brain. Sign in to an AI account you already have, or start free.", card: { kind: "engine" } }];
    case "apps":
      return [
        { step, text: "Connect your email and I'll find something I can take care of right away. Nothing gets sent without your approval. Or just tell me what you need." },
        ...ONBOARDING_APPS.filter(app => app.id !== "googlecalendar").map(app => ({ step, text: "", card: { kind: "connect" as const, app: app.id, connected: ctx.connected.includes(app.id) } })),
      ];
    case "first-task":
      return [{ step, text: "Pick one to start, or type anything.", card: { kind: "suggestions", items: FIRST_TASKS.map(task => ({ ...task })) } }];
    case "done":
      return [];
  }
}

export function initialOnboardingState(botId: string, threadId: string, botName: string, engineReady: boolean): OnboardingChatState {
  return { version: ONBOARDING_CHAT_VERSION, botId, threadId, step: "greet", botName, engineReady, connected: [], completedAt: "" };
}

/** Pure step machine. Unknown or out-of-order events leave the state unchanged,
 * so a retried tap is harmless. Anything the person types before "done" is a
 * first-task event: they never have to finish setup to get work done. */
export function nextOnboardingState(state: OnboardingChatState, event: OnboardingChatEvent, now: () => Date = () => new Date()): OnboardingChatState {
  if (state.step === "done") return state;
  const after = (step: OnboardingChatStep): OnboardingChatStep =>
    step === "greet" ? "name"
    : step === "name" ? "about"
    : step === "about" ? (state.engineReady ? "apps" : "engine")
    : step === "engine" ? "apps"
    : step === "apps" ? "first-task"
    : "done";
  const finish = (next: OnboardingChatState): OnboardingChatState =>
    next.step === "done" ? { ...next, completedAt: now().toISOString() } : next;
  switch (event.type) {
    case "start": return state.step === "greet" ? { ...state, step: "name" } : state;
    case "name": {
      const botName = cleanName(event.value);
      if (state.step !== "name" || !botName) return state;
      return { ...state, botName, step: state.engineReady ? "apps" : "engine" };
    }
    case "engine-ready":
      return { ...state, engineReady: true, step: state.step === "engine" ? "apps" : state.step };
    case "connected":
      return state.connected.includes(event.app) ? state
        : { ...state, connected: [...state.connected, event.app], step: state.step === "apps" ? "first-task" : state.step };
    case "skip":
      return finish({ ...state, step: after(state.step) });
    case "first-task":
      return event.prompt.trim() ? finish({ ...state, step: "done" }) : state;
  }
}
