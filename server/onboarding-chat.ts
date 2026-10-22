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
  preparedGreeting,
  type OnboardingAppId,
  type OnboardingChatEvent,
  type OnboardingChatMessage,
  type OnboardingChatState,
  type OnboardingChatStep,
} from "../shared/onboarding-chat.ts";
import type { WireMessage } from "../shared/wire.ts";
import type { StarterJob } from "../shared/app-config.ts";

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
  z.object({
    type: z.literal("prepared"),
    profile: z.array(z.object({ label: z.string().trim().min(1).max(40), value: z.string().max(600) }).strict()).max(12),
    team: z.array(z.object({ name: z.string().trim().min(1).max(40), job: z.string().trim().min(1).max(240) }).strict()).max(8),
    firstJob: z.object({ title: z.string().trim().min(1).max(80), prompt: z.string().trim().min(1).max(4000) }).strict().optional(),
  }).strict(),
]);

/** Validate a request body's `event`. Unknown types and stray fields are refused. */
export function parseOnboardingChatEvent(value: unknown): { ok: true; event: OnboardingChatEvent } | { ok: false; error: string } {
  const parsed = onboardingChatEventSchema.safeParse(value);
  if (parsed.success) return { ok: true, event: parsed.data };
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  return {
    ok: false,
    error: typeof type === "string" && !["start", "name", "engine-ready", "connected", "skip", "first-task", "prepared"].includes(type)
      ? `unknown onboarding event "${type.slice(0, 40)}"`
      : "event must be one of start, name, engine-ready, connected, skip, first-task or prepared, with its fields",
  };
}

type OnboardingLine = Pick<WireMessage, "id"> & Partial<Pick<WireMessage, "role">> & { onboarding?: OnboardingChatMessage };

export interface OnboardingChatHost {
  /** The person's name from the profile; the greeting uses the first word. */
  personName: string;
  /** False when connected apps can't work here, so no connect cards post. */
  appsAvailable?: boolean;
  freeEngine?: boolean;
  starterJobs?: readonly StarterJob[];
  messages(threadId: string): readonly OnboardingLine[];
  append(threadId: string, line: OnboardingChatMessage): void;
  patch(threadId: string, messageId: string, line: OnboardingChatMessage): void;
  /** The untouched first-run seed greeting, if the thread holds only that.
   * The first greet line replaces it so setup never opens with two hellos. */
  seedGreeting?(threadId: string): string | null;
  /** Called once the person names the bot. */
  rename?(botId: string, name: string): void;
  /** Put this conversation's bot first in the roster, so an app opening
   * fresh lands on it rather than on a teammate hired after it. */
  lead?(threadId: string): void;
  save(state: OnboardingChatState): void;
}

/** Apply one event: move the step machine, post the new step's lines once
 * per (thread, step), update answered cards in place, then persist. Lines
 * are posted before the record is saved, so a crash in between leaves a
 * replay that finds the lines already there and posts nothing twice. */
export function applyOnboardingChatEvent(host: OnboardingChatHost, before: OnboardingChatState, event: OnboardingChatEvent, now: () => Date = () => new Date()): OnboardingChatState {
  if (event.type === "prepared") {
    // the greeting becomes what was researched about the business; never
    // once the person has joined the conversation
    const rows = host.messages(before.threadId);
    if (rows.some((row) => row.role === "user")) return before;
    const line = preparedGreeting({ personName: host.personName, botName: before.botName }, event);
    const greet = rows.find((row) => row.onboarding?.step === "greet")?.id ?? host.seedGreeting?.(before.threadId);
    if (greet) host.patch(before.threadId, greet, line);
    else host.append(before.threadId, line);
    // the researched team was hired after bos, and a fresh app opens on
    // the first bot; the greeting is what it should open on
    host.lead?.(before.threadId);
    return before;
  }
  let state = nextOnboardingState(before, event, now);
  const { threadId } = state;
  const posted = new Set(host.messages(threadId).flatMap((message) => message.onboarding ? [message.onboarding.step] : []));
  const post = (step: OnboardingChatStep) => {
    if (posted.has(step)) return;
    posted.add(step);
    const ctx = { personName: host.personName, botName: state.botName, engineReady: state.engineReady, connected: state.connected, appsAvailable: host.appsAvailable,
      freeEngine: host.freeEngine, starterJobs: host.starterJobs };
    const lines = onboardingScript(step, ctx);
    const seed = step === "greet" && lines.length ? host.seedGreeting?.(threadId) : null;
    if (seed) host.patch(threadId, seed, lines[0]);
    for (const line of seed ? lines.slice(1) : lines) host.append(threadId, line);
  };
  if (state.step === "done") {
    // typing early (or skipping the last card) ends setup; nothing more
    // posts, except the one greeting when start itself ends setup
    if (event.type === "start" && before.step === "greet") post("greet");
  } else if (before.step === "greet" && state.step !== "greet") {
    post("greet");
    post(state.step);
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
