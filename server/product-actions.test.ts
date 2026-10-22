import { expect, it, vi } from "vitest";
import { ProductActions, canConfirmJob } from "./product-actions.ts";

it("sends only typed claim identity, and never sends anything when disabled", async () => {
  let enabled = true;
  const transport = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: "receipt" }, { status: 201 }));
  const actions = new ProductActions({ installId: () => enabled ? "test-213-actions" : null, feedbackEnabled: () => true, fetch: transport });
  await expect(actions.claim(" typed@example.com ")).resolves.toEqual({ ok: true });
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ install_id: "test-213-actions", email: "typed@example.com" });
  enabled = false;
  await expect(actions.claim("typed@example.com")).resolves.toEqual({ ok: false });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("bounds optional feedback and sends rating-only with no message content or ids", async () => {
  const transport = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => Response.json({ id: "receipt" }));
  const actions = new ProductActions({ installId: () => "test-213-actions", feedbackEnabled: () => true, fetch: transport });
  await expect(actions.feedback({ text: "", rating: "up", message: "private", messageId: "private" })).resolves.toEqual({ ok: true });
  expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({ install_id: "test-213-actions", text: "", rating: "up" });
  await expect(actions.feedback({ text: "a".repeat(4001) })).resolves.toEqual({ ok: false });
  await expect(actions.feedback({ text: "", rating: "bad" })).resolves.toEqual({ ok: false });
  expect(transport).toHaveBeenCalledTimes(1);
});
it("requires a real successful result after a person message before a useful-job confirmation", () => {
  expect(canConfirmJob([{ role: "bot", kind: "text", text: "Welcome" }])).toBe(false);
  expect(canConfirmJob([{ role: "user", kind: "text", text: "Help" }, { role: "bot", kind: "activity", turnOutcome: { ok: false } }])).toBe(false);
  expect(canConfirmJob([{ role: "user", kind: "text", text: "Help" }, { role: "bot", kind: "text", text: "Result" }, { role: "bot", kind: "activity", turnOutcome: { ok: true } }])).toBe(true);
});
