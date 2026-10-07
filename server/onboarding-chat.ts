// Server side of the 2.0 chat onboarding (shared/onboarding-chat.ts is the
// contract). The workspace config holds the record (`onboarding.chat`); this
// module applies one event to it and posts the bot's scripted lines into the
// first bot's thread. The host (server/index.ts) supplies persistence and the
// transcript, so the whole sequence is testable without a running server.
import { z } from "zod";
import {
  ONBOARDING_APPS,
  nextOnboardingState,
  onboardingScript,
  type OnboardingAppId,
  type OnboardingChatEvent,
  type OnboardingChatMessage,
  type OnboardingChatState,
  type OnboardingChatStep,
} from "../shared/onboarding-chat.ts";
import type { WireMessage } from "../shared/wire.ts";

const STEPS = ["greet", "name", "about", "engine", "apps", "first-task", "done"] as const satisfies readonly OnboardingChatStep[];
const APP_IDS = ONBOARDING_APPS.map((app) => app.id) as [OnboardingAppId, ...OnboardingAppId[]];
const recordId = z.string().regex(/^[\w-]+$/).max(80);

/** Stored shape of `onboarding.chat`. config.ts degrades a bad record to
 * absent instead of rejecting the whole config file. */
export const onboardingChatStateSchema = z.object({
  version: z.number().int().min(0).max(1000),
  botId: recordId,
  threadId: recordId,
  step: z.enum(STEPS),
  botName: z.string().max(80),
  engineReady: z.boolean(),
  connected: z.array(z.enum(APP_IDS)).max(APP_IDS.length),
  completedAt: z.string().max(40),
});

const onboardingChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("name"), value: z.string().max(200) }).strict(),
  z.object({ type: z.literal("engine-ready") }).strict(),
  z.object({ type: z.literal("connected"), app: z.enum(APP_IDS) }).strict(),
  z.object({ type: z.literal("skip") }).strict(),
  z.object({ type: z.literal("first-task"), prompt: z.string().max(20_000) }).strict(),
]);

/** Validate a request body's `event`. Unknown types and stray fields are refused. */
export function parseOnboardingChatEvent(value: unknown): { ok: true; event: OnboardingChatEvent } | { ok: false; error: string } {
  const parsed = onboardingChatEventSchema.safeParse(value);
  if (parsed.success) return { ok: true, event: parsed.data };
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  return {
    ok: false,
    error: typeof type === "string" && !["start", "name", "engine-ready", "connected", "skip", "first-task"].includes(type)
      ? `unknown onboarding event "${type.slice(0, 40)}"`
      : "event must be one of start, name, engine-ready, connected, skip or first-task, with its fields",
  };
}

type OnboardingLine = Pick<WireMessage, "id"> & { onboarding?: OnboardingChatMessage };

export interface OnboardingChatHost {
  /** The person's name from the profile; the greeting uses the first word. */
  personName: string;
  messages(threadId: string): readonly OnboardingLine[];
  append(threadId: string, line: OnboardingChatMessage): void;
  patch(threadId: string, messageId: string, line: OnboardingChatMessage): void;
  /** Called once the person names the bot. */
  rename?(botId: string, name: string): void;
  save(state: OnboardingChatState): void;
}

/** Apply one event: move the step machine, post the new step's lines once
 * per (thread, step), update answered cards in place, then persist. Lines
 * are posted before the record is saved, so a crash in between leaves a
 * replay that finds the lines already there and posts nothing twice. */
export function applyOnboardingChatEvent(host: OnboardingChatHost, before: OnboardingChatState, event: OnboardingChatEvent, now: () => Date = () => new Date()): OnboardingChatState {
  let state = nextOnboardingState(before, event, now);
  const { threadId } = state;
  const posted = new Set(host.messages(threadId).flatMap((message) => message.onboarding ? [message.onboarding.step] : []));
  const post = (step: OnboardingChatStep) => {
    if (posted.has(step)) return;
    posted.add(step);
    const ctx = { personName: host.personName, botName: state.botName, engineReady: state.engineReady, connected: state.connected };
    for (const line of onboardingScript(step, ctx)) host.append(threadId, line);
  };
  if (state.step === "done") {
    // typing early (or skipping the last card) ends setup; nothing more posts
  } else if (before.step === "greet" && state.step === "name") {
    post("greet");
    post("name");
  } else if (before.step === "name" && state.step !== "name") {
    post("about");
    // "about" carries no card, so a skipped name walks straight past it
    if (state.step === "about") state = nextOnboardingState(state, { type: "skip" }, now);
    post(state.step);
  } else if (state.step !== before.step) {
    post(state.step);
  }
  if (event.type === "name" && state.botName !== before.botName) {
    host.rename?.(state.botId, state.botName);
  }
  // answered cards flip in place, so a reload shows them settled
  if (event.type === "name" || event.type === "connected") {
    for (const message of host.messages(threadId)) {
      const line = message.onboarding;
      const card = line?.card;
      if (!line || !card) continue;
      if (event.type === "name" && card.kind === "name-input" && state.step !== "name" && (!card.submitted || card.value !== state.botName)) {
        host.patch(threadId, message.id, { ...line, card: { ...card, value: state.botName, submitted: true } });
      }
      if (event.type === "connected" && card.kind === "connect" && card.app === event.app && !card.connected && state.connected.includes(event.app)) {
        host.patch(threadId, message.id, { ...line, card: { ...card, connected: true } });
      }
    }
  }
  if (JSON.stringify(state) !== JSON.stringify(before)) host.save(state);
  return state;
}

/** The connectors whose successful connection advances onboarding. */
export const ONBOARDING_CONNECT_APPS: readonly OnboardingAppId[] = ["gmail", "outlook"];
