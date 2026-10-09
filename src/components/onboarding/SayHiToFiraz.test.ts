import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ state: { config: { profile: { name: "Putri", email: "" } } as any }, dispatch: vi.fn() }));
vi.mock("@/state/store", () => ({ useStore: () => fixture, api: vi.fn() }));
vi.mock("@/components/Avatar", () => ({ MausAvatar: () => createElement("span", null, "mascot") }));
const { SayHiToFiraz } = await import("./SayHiToFiraz");

it("offers the chat on by default with the profile name and a skip", () => {
  const html = renderToStaticMarkup(createElement(SayHiToFiraz, { onDone: () => {} }));
  expect(html).toContain("Say hi to Firaz");
  expect(html).toContain('value="Putri"');
  expect(html).toMatch(/<button(?![^>]*\sdisabled=)[^>]*>Say hi</);
  expect(html).toMatch(/<button(?![^>]*\sdisabled=)[^>]*>Skip</);
});

it("waits for a name when the profile has none", () => {
  fixture.state.config = { profile: { name: "", email: "" } };
  const html = renderToStaticMarkup(createElement(SayHiToFiraz, { onDone: () => {} }));
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Say hi</);
});
