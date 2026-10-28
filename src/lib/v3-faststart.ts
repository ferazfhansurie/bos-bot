// 3.0's 60-second start (server/faststart.ts): the person pastes their site or
// instagram and bos hires a starter team for their business. These decide
// where the card shows and when the web's first visit keeps the composer bare.
// Pure, for tests; only read when the v3 flag is on.
import type { Message } from "@/state/store";

type OnboardingConfig = { onboarding?: { chat?: { threadId: string } } } | null | undefined;

/** The person has written in this thread (a starter tap counts). */
export function hasUserMessage(messages: readonly Pick<Message, "role">[]): boolean {
  return messages.some((message) => message.role === "user");
}

/** The greeting already reads their business: a prepared invite or a 60-second start. */
export function hasPreparedGreeting(messages: readonly Pick<Message, "onboarding">[]): boolean {
  return messages.some((message) => {
    const card = message.onboarding?.card;
    return card?.kind === "suggestions" && card.items.some((item) => item.id === "prepared");
  });
}

export function isOnboardingThread(config: OnboardingConfig, threadId: string | undefined): boolean {
  return !!threadId && config?.onboarding?.chat?.threadId === threadId;
}

/** The chat offers the 60-second start: bos's first conversation, before the
 * person writes and before any greeting about their business. */
export function fastStartInChat(config: OnboardingConfig, threadId: string | undefined, messages: readonly Pick<Message, "role" | "onboarding">[]): boolean {
  return isOnboardingThread(config, threadId) && !hasUserMessage(messages) && !hasPreparedGreeting(messages);
}

/** The web's first visit: one bot, no computer or engine pickers, the composer
 * ready. It lasts until the person sends their first message. */
export function firstVisit(web: boolean, config: OnboardingConfig, threadId: string | undefined, messages: readonly Pick<Message, "role">[]): boolean {
  return web && isOnboardingThread(config, threadId) && !hasUserMessage(messages);
}

/** The home board offers it while there is no team yet: one visible bot of your own. */
export function fastStartOnHome(bots: readonly { hidden?: boolean; remote?: unknown }[]): boolean {
  return bots.filter((bot) => !bot.hidden && !bot.remote).length <= 1;
}

/** What the card says it is reading. */
export function readingLabel(input: string): string {
  const value = input.trim();
  if (value.startsWith("@")) return value;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`);
    const ig = url.hostname.replace(/^www\./, "") === "instagram.com" ? url.pathname.split("/").filter(Boolean)[0] : undefined;
    return ig ? `@${ig}` : url.hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}
