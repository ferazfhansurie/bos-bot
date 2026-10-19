import { expect, it } from "vitest";
import { pendingRequestMessage, requestContinuationUrl, REQUEST_LINK_MAX_AGE_MS } from "./request-continuation.ts";
import type { Message } from "./store.ts";
it("only links the exact pending request and rejects settled, wrong and expired cards", () => {
  const now = Date.now();
  const message = { id: "message", role: "bot", kind: "options", at: now - 1000,
    card: { requestId: "request", tool: "fixture", title: "Permission", options: [] } } as unknown as Message;
  const input = { messageId: "message", requestId: "request" };
  expect(pendingRequestMessage([message], input, now)).toEqual(message);
  expect(pendingRequestMessage([message], { ...input, requestId: "other" }, now)).toBeUndefined();
  expect(pendingRequestMessage([{ ...message, card: { ...message.card!, answered: "confirmed" } }], input, now)).toBeUndefined();
  expect(pendingRequestMessage([{ ...message, card: { ...message.card!, dismissed: true } }], input, now)).toBeUndefined();
  expect(pendingRequestMessage([message], input, now + REQUEST_LINK_MAX_AGE_MS)).toBeUndefined();
  const url = new URL(requestContinuationUrl("home", "bot", "thread", message));
  expect(url.protocol).toBe("bosbot:");
  expect([...url.searchParams.keys()].sort()).toEqual(["bot", "home", "message", "request", "thread"]);
});
