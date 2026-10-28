import { describe, expect, it } from "vitest";
import type { HealthReport } from "../../shared/doctor";
import { botStalled, buildFixIts, stalledThread, type FixItBot } from "./v3-fix-it";
import type { InboxItem } from "./inbox";

const report = (checks: HealthReport["checks"], selfHealEnabled?: boolean): HealthReport => ({
  checkedAt: 1, checks, notices: [], safeMode: { enabled: false, reason: null }, ...(selfHealEnabled === undefined ? {} : { selfHealEnabled }),
});
const bot = (overrides: Partial<FixItBot> = {}): FixItBot => ({ id: "atlas", name: "Atlas", threadId: "main", ...overrides });

describe("buildFixIts", () => {
  it("is empty when everything is fine", () => {
    expect(buildFixIts({ report: report([{ id: "engine", status: "ok", detail: "" }]), bots: [bot()] })).toEqual([]);
    expect(buildFixIts({ report: null, bots: [] })).toEqual([]);
  });

  it("turns a signed-out engine into one sign-in card and folds dead bots into it", () => {
    const cards = buildFixIts({
      report: report([{ id: "engine", status: "warning", detail: "No signed-in engine is ready." }]),
      bots: [bot({ activity: "dead" })],
    });
    expect(cards.map((card) => card.id)).toEqual(["engine"]);
    expect(cards[0]).toMatchObject({ title: "Your AI is signed out", button: "Sign in", action: { kind: "settings", section: "engines" } });
  });

  it("names a missing CLI only when no engine is ready", () => {
    const cli = { id: "cli", status: "warning" as const, detail: "8 configured engine CLIs are missing." };
    expect(buildFixIts({ report: report([{ id: "engine", status: "ok", detail: "" }, cli]), bots: [] })).toEqual([]);
    expect(buildFixIts({ report: report([{ id: "engine", status: "warning", detail: "" }, cli]), bots: [bot({ activity: "dead" })] }).map((card) => card.id)).toEqual(["cli"]);
  });

  it("gives every dead bot its own card that opens the dead thread", () => {
    const cards = buildFixIts({ report: null, bots: [
      bot({ activity: "dead", tasks: [{ threadId: "main" }, { threadId: "t2", activity: "dead" }] }),
      bot({ id: "hidden", name: "Hidden", activity: "dead", hidden: true }),
      bot({ id: "busy", name: "Busy", activity: "working" }),
    ] });
    expect(cards).toEqual([expect.objectContaining({ id: "dead:atlas", title: "Atlas can't start", action: { kind: "thread", botId: "atlas", threadId: "t2" } })]);
  });

  it("groups offline computers, one card each", () => {
    const home = { homeId: "h1", homeName: "Studio", ownerName: "Aina", online: false };
    const cards = buildFixIts({ report: null, bots: [
      bot({ id: "rb-1", name: "One", remote: home }),
      bot({ id: "rb-2", name: "Two", remote: home }),
      bot({ id: "rb-3", name: "Three", remote: { homeId: "h2", homeName: "Office", ownerName: null, online: true, availability: "update-required" } }),
      bot({ id: "rb-4", name: "Four", remote: { homeId: "h3", homeName: "Fine", ownerName: null, online: true, availability: "ready" } }),
      bot({ id: "srv", name: "Server bot", homeLink: { id: "s1", name: "VPS", online: false } }),
    ] });
    expect(cards.map((card) => [card.id, card.title, card.detail])).toEqual([
      ["computer:h1", "Aina's Mac is offline", "2 bots there can't work until it's back."],
      ["computer:h2", "Office needs a BOS update", "Three can't work until it's back."],
      ["server:s1", "VPS is offline", "Server bot can't work until it's back."],
    ]);
    expect(cards[2].action).toEqual({ kind: "settings", section: "desktopWorkspaces" });
  });

  it("shows an expired app once and opens its card's thread", () => {
    const ask = (threadId: string): InboxItem => ({ id: `question:${threadId}`, kind: "question", botId: "atlas", threadId, title: "", preview: "", at: 1, connect: { slug: "gmail", label: "Gmail", reconnect: true } });
    const cards = buildFixIts({ report: null, bots: [bot()], asks: [ask("t1"), ask("t2"), { ...ask("t3"), connect: { slug: "notion", label: "Notion" } }] });
    expect(cards).toEqual([{ id: "app:gmail", title: "Gmail is signed out", detail: "Atlas needs it to keep going.", button: "Sign in again", action: { kind: "thread", botId: "atlas", threadId: "t1" } }]);
  });

  it("offers WhatsApp reconnect only when the doctor can do it and self-heal is on", () => {
    const action = { id: "whatsapp", status: "warning" as const, detail: "", fix: { kind: "action" as const, action: "reconnect-whatsapp" as const, label: "Reconnect WhatsApp" } };
    expect(buildFixIts({ report: report([action]), bots: [] }).map((card) => card.action)).toEqual([{ kind: "doctor", action: "reconnect-whatsapp" }]);
    expect(buildFixIts({ report: report([action], false), bots: [] })).toEqual([]);
    const neverLinked = { ...action, fix: { kind: "settings" as const, section: "connections" as const, label: "Open connections" } };
    expect(buildFixIts({ report: report([neverLinked]), bots: [] })).toEqual([]);
  });

  it("warns about a full disk", () => {
    expect(buildFixIts({ report: report([{ id: "disk", status: "warning", detail: "0.4 GB free" }]), bots: [] }))
      .toEqual([expect.objectContaining({ id: "disk", action: { kind: "settings", section: "health" } })]);
  });
});

describe("stalled bots", () => {
  it("dead and no-signal stall; working, waiting and idle do not", () => {
    expect(botStalled({ activity: "dead" })).toBe(true);
    expect(botStalled({ activity: "no-signal" })).toBe(true);
    expect(botStalled({ activity: "working" })).toBe(false);
    expect(botStalled({})).toBe(false);
    expect(stalledThread(bot({ activity: "dead" }))).toBe("main");
  });
});

describe("fix-it funnel class", () => {
  it("sends only the kind of failure, never a name", async () => {
    const { fixItCheck } = await import("../components/V3FixIt");
    expect(["engine", "cli", "dead:atlas", "computer:h1", "server:s1", "app:gmail", "whatsapp", "disk", "x"].map(fixItCheck))
      .toEqual(["engine", "engine", "engine", "network", "network", "auth", "whatsapp", "storage", "unknown"]);
  });
});
