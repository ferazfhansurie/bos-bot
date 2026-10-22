import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ config: { flags: { plans: true, invite: true, activationTelemetry: true }, pricing: [] } }));
vi.mock("@/lib/app-config", () => ({ useAppConfig: () => fixture.config }));
vi.mock("@/state/store", () => ({ api: vi.fn() }));
const { PlansCard } = await import("./PlansCard");

beforeEach(() => { fixture.config.flags = { plans: true, invite: true, activationTelemetry: true }; });
it("offers plans and invites with an unchecked useful-result confirmation", () => {
  const html = renderToStaticMarkup(createElement(PlansCard));
  expect(html).toContain("View plans");
  expect(html).toContain("Invite a friend");
  expect(html).not.toContain("checked=");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Confirm useful result/);
});
it("respects conversion and confirmation flags independently", () => {
  fixture.config.flags = { plans: false, invite: true, activationTelemetry: false };
  const html = renderToStaticMarkup(createElement(PlansCard));
  expect(html).toContain("Invite a friend");
  expect(html).not.toContain("View plans");
  expect(html).not.toContain("Confirm useful result");
  fixture.config.flags.invite = false;
  expect(renderToStaticMarkup(createElement(PlansCard))).toBe("");
});
