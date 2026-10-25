import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deskCardSource, deskMatchesUrl } from "../shared/desks.ts";
import { cardProblem, DeskStore } from "./desks.ts";

const dirs: string[] = [];
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), "desks-"));
  dirs.push(dir);
  let t = 1_000;
  return { dir, desks: new DeskStore(dir, () => t++) };
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const TODAY = 'root = Col([Title("today"), Stat("unread", data.unread), Button("draft replies", @ToAssistant("draft replies for unread chats"))])';

describe("desk store", () => {
  it("makes one desk per app and reuses it when the same app opens again", () => {
    const { dir, desks } = store();
    const first = desks.open("bot-a", "t1", { name: "gmail", url: "https://mail.google.com/mail/u/0/" });
    expect(first.created).toBe(true);
    expect(first.desk).toMatchObject({ kind: "browser", host: "mail.google.com", status: "needs_sign_in", pinned: false });
    const again = desks.open("bot-a", "t2", { name: "my gmail", url: "https://mail.google.com/" });
    expect(again.created).toBe(false);
    expect(again.desk.id).toBe(first.desk.id);
    expect(again.desk.threadId).toBe("t2");
    expect(desks.list("bot-a")).toHaveLength(1);
    expect(desks.list("bot-b")).toHaveLength(0);
    expect(statSync(join(dir, "desks", "bot-a.json")).mode & 0o777).toBe(0o600);
  });

  it("whatsapp desks need no url and start ready", () => {
    const { desks } = store();
    const { desk } = desks.open("bot-a", "t1", { name: "whatsapp", kind: "whatsapp" });
    expect(desk).toMatchObject({ kind: "whatsapp", host: "web.whatsapp.com", status: "ready" });
    expect(desks.open("bot-a", "t1", { name: "wa", kind: "whatsapp" }).desk.id).toBe(desk.id);
  });

  it("refuses non-https urls and a new browser desk without one", () => {
    const { desks } = store();
    expect(() => desks.open("bot-a", "t1", { name: "x", url: "javascript:alert(1)" })).toThrow(/https/);
    expect(() => desks.open("bot-a", "t1", { name: "x", url: "http://example.com" })).toThrow(/https/);
    expect(() => desks.open("bot-a", "t1", { name: "x" })).toThrow(/needs the app's url/);
    expect(desks.open("bot-a", "t1", { name: "fixture", url: "http://127.0.0.1:4100/" }).desk.host).toBe("127.0.0.1");
  });

  it("saves cards only when they draw, and keeps layout when data refreshes", () => {
    const { desks } = store();
    const { desk } = desks.open("bot-a", "t1", { name: "wa", kind: "whatsapp" });
    expect(() => desks.card("bot-a", desk.id, { card_id: "today", title: "today", code: 'root = Col([Nope("x")])' })).toThrow(/would not draw: Unknown component "Nope"/);
    expect(() => desks.card("bot-a", desk.id, { card_id: "today", title: "today", code: 'root = Col([Title("x"' })).toThrow(/would not draw/);
    expect(desks.get("bot-a", desk.id)!.cards).toHaveLength(0);

    desks.card("bot-a", desk.id, { card_id: "today", title: "today", code: TODAY, data: { unread: 3 } });
    const refreshed = desks.card("bot-a", desk.id, { card_id: "today", data: { unread: 7 } });
    expect(refreshed.card).toMatchObject({ code: TODAY, data: { unread: 7 }, title: "today" });
    expect(deskCardSource(refreshed.card!)).toContain('data = {"unread":7}');

    const custom = TODAY.replace("])", ', Button("follow up", @ToAssistant("follow up stale chats"))])');
    desks.card("bot-a", desk.id, { card_id: "today", code: custom });
    expect(desks.get("bot-a", desk.id)!.cards[0]).toMatchObject({ code: custom, data: { unread: 7 } });

    expect(desks.card("bot-a", desk.id, { card_id: "today", remove: true }).removed).toBe(true);
    expect(desks.get("bot-a", desk.id)!.cards).toHaveLength(0);
  });

  it("pins, signs in and removes from the owner side", () => {
    const { desks } = store();
    const { desk } = desks.open("bot-a", "t1", { name: "ads", url: "https://adsmanager.facebook.com/" });
    const patched = desks.patch("bot-a", desk.id, { pinned: true, status: "ready" });
    expect(patched).toMatchObject({ pinned: true, status: "ready" });
    expect(patched.rev).toBeGreaterThan(desk.rev);
    expect(desks.remove("bot-a", desk.id)).toBe(true);
    expect(desks.remove("bot-a", desk.id)).toBe(false);
    expect(() => desks.patch("bot-a", desk.id, { pinned: true })).toThrow(/no desk/);
  });

  it("rejects path-like bot ids", () => {
    const { desks } = store();
    expect(() => desks.list("../x")).toThrow(/bad bot id/);
  });
});

describe("desk helpers", () => {
  it("keeps code that defines its own data", () => {
    expect(deskCardSource({ code: 'root = Col([Title(data.a)])\ndata = {"a": "x"}', data: { a: "y" } })).not.toContain('"y"');
  });
  it("matches browser tabs by host and subdomain", () => {
    expect(deskMatchesUrl({ host: "www.facebook.com" }, "https://business.facebook.com/x")).toBe(true);
    expect(deskMatchesUrl({ host: "mail.google.com" }, "https://mail.google.com/mail/u/0/#inbox")).toBe(true);
    expect(deskMatchesUrl({ host: "mail.google.com" }, "https://evilmail.google.com.example/")).toBe(false);
  });
  it("explains code that is not openui", () => {
    expect(cardProblem("hello")).toMatch(/nothing to draw/);
    expect(cardProblem('root = Col([Title("ok")])')).toBeNull();
  });
});
