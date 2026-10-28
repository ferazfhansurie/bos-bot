import { expect, it } from "vitest";
import { productEvent } from "./product-events.ts";

it("drops unknown events and all unstructured text, ids, paths and engine names", () => {
  expect(productEvent("my private job")).toBeNull();
  expect(productEvent("error", { class: "auth", message: "secret", path: "/private", count: 2, engine: "my-token" }, 0))
    .toEqual({ name: "error", at: "1970-01-01T00:00:00.000Z", props: { class: "auth", count: 2 } });
});
it("allows only finite nonnegative bounded counts and named enumerations", () => {
  expect(productEvent("engine_connected", { engine: "claude", count: Infinity, members: -1, room: true, source: "chat" }, 0)?.props)
    .toEqual({ engine: "claude", room: true, source: "chat" });
});
it("does not interpret prototype field names as property enums", () => {
  expect(productEvent("error", JSON.parse('{"constructor":"private","toString":"private","__proto__":{"class":"auth"}}'), 0)?.props).toEqual({});
});
it("carries the 3.0 funnel events with only their card kind", () => {
  expect(productEvent("card_clicked", { card: "fixit", check: "auth", title: "Gmail is signed out", botId: "atlas" }, 0)?.props).toEqual({ card: "fixit", check: "auth" });
  expect(productEvent("connect_finished", { success: false, source: "chat", app: "gmail" }, 0)?.props).toEqual({ success: false, source: "chat" });
  expect(productEvent("card_clicked", { card: "somewhere" }, 0)?.props).toEqual({});
  for (const name of ["island_seen", "connect_started", "automation_created"]) expect(productEvent(name, undefined, 0)?.name).toBe(name);
});
