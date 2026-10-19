import type { Message } from "./store.ts";
export const REQUEST_LINK_MAX_AGE_MS = 7 * 86_400_000;
export function pendingRequestMessage(messages: Message[], input: { messageId: string; requestId: string }, now = Date.now()): Message | undefined {
  return messages.find(message => message.id === input.messageId && message.kind === "options" &&
    message.card?.requestId === input.requestId && !message.card.answered && !message.card.dismissed &&
    Boolean(message.card.tool || message.card.questionRequest) && message.at <= now && message.at > now - REQUEST_LINK_MAX_AGE_MS);
}
export function requestContinuationUrl(home: string, bot: string, thread: string, message: Message): string {
  const query = new URLSearchParams({ home, bot, thread, message: message.id, request: message.card!.requestId! });
  return `bosbot://request?${query}`;
}
