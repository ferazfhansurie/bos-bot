import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UpdateView } from "@/lib/bos-update";
import { ConfirmUpdateLine, UpdatePill, UpdateProgress, UpdatesPanel, UpdateResultToast, busyEntries } from "./BosUpdate";
import type { Bot } from "@/state/store";

vi.mock("./Avatar", () => ({ BotAvatar: () => createElement("span", { "data-avatar": "" }) }));

const status = {
  state: "ready" as const,
  current: { version: "1.2.0", sha: "2d83ba23aaaa" },
  candidate: { version: "1.3.0", sha: "abcdef123456", branch: "prod", notes: ["Update & restart button"] },
  busyTurns: [{ botId: "b1", threadId: "t1" }],
};
const view = (patch: Partial<UpdateView> = {}): UpdateView => ({ status, state: "ready", offline: false, error: null, log: [], pending: null, checking: false, ...patch });
const noop = () => {};

describe("BosUpdate", () => {
  it("pill hides when idle, shows from → to when a newer build is allowed, spins while running", () => {
    expect(renderToStaticMarkup(createElement(UpdatePill, { view: view({ state: "idle" }), onOpen: noop }))).toBe("");
    expect(renderToStaticMarkup(createElement(UpdatePill, { view: view(), onOpen: noop }))).toContain("1.2.0 → 1.3.0");
    const running = renderToStaticMarkup(createElement(UpdatePill, { view: view({ state: "building" }), onOpen: noop }));
    expect(running).toContain("Updating…");
    expect(running).toContain("Building");
  });

  it("settings names both builds, what's in it, and the update button", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view(), busy: [], onApply: noop, onRestart: noop }));
    expect(html).toContain("BOS 1.2.0");
    expect(html).toContain("Newer build on prod");
    expect(html).toContain("What&#x27;s in it");
    expect(html).toContain(">Update<");
    expect(html).toContain("Restart");
  });

  it("no candidate: check button and the guard's reason", () => {
    const idle = { ...status, state: "idle" as const, candidate: undefined, reason: "already on the newest prod build" };
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view({ status: idle, state: "idle" }), busy: [], onApply: noop, onRestart: noop, onCheck: noop }));
    expect(html).toContain("Check for updates");
    expect(html).toContain("already on the newest prod build");
    expect(html).toContain("Up to date");
  });

  it("does not call a missing full shell current", () => {
    const idle = { ...status, state: "idle" as const, candidate: undefined, shellRequired: true, lastResult: { state: "done" as const, at: "now", to: status.current }, reason: "full desktop package required: no validated candidate" };
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view({ status: idle, state: "idle" }), busy: [], onApply: noop, onRestart: noop, onCheck: noop }));
    expect(html).toContain("Desktop shell update required");
    expect(html).not.toContain("Up to date");
    expect(html).not.toContain(">Update<");
    expect(html).not.toContain("Updated to");
  });

  it("does not show current while check is unknown or failed", () => {
    for (const reason of [undefined, "check failed: source unavailable"]) {
      const idle = { ...status, state: "idle" as const, candidate: undefined, reason };
      const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view({ status: idle, state: "idle" }), busy: [], onApply: noop, onRestart: noop }));
      expect(html).not.toContain("Up to date");
    }
  });

  it("buttons lock while a run is in progress and the step list shows", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view({ state: "applying" }), busy: [], onApply: noop, onRestart: noop }));
    expect(html).toContain("Updating to 1.3.0");
    expect(html).toContain('aria-current="step"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("draining names the bots it is waiting for", () => {
    const busy = busyEntries(view({ status: { ...status, busyTurns: [{ botId: "b1", threadId: "t1", botName: "pix" }, { botId: "b2", threadId: "t2" }] } }), [
      { id: "b2", name: "pipe" } as unknown as Bot,
    ]);
    const html = renderToStaticMarkup(createElement(UpdateProgress, { view: view({ state: "draining" }), busy }));
    expect(html).toContain("Waiting for 2 bots to finish (pix, pipe)");
  });

  it("confirm is one line with from → to and who finishes first", () => {
    const bots = [{ id: "b1", name: "bos bot", tasks: [{ threadId: "t1", title: "geng · resume" }] }] as unknown as Bot[];
    const busy = busyEntries(view(), bots);
    expect(busy).toEqual([expect.objectContaining({ name: "bos bot", threadTitle: "geng · resume" })]);
    const html = renderToStaticMarkup(createElement(ConfirmUpdateLine, { kind: "apply", from: "1.2.0", to: "1.3.0", busy, onConfirm: noop, onCancel: noop }));
    expect(html).toContain("Update 1.2.0 → 1.3.0 and restart?");
    expect(html).toContain("bos bot finishes first");
    const panel = renderToStaticMarkup(createElement(UpdatesPanel, { view: view(), busy, onApply: noop, onRestart: noop, initialConfirm: "apply" }));
    expect(panel).toContain('aria-label="Confirm update"');
  });

  it("building comes first and shows the build output tail, collapsed", () => {
    const html = renderToStaticMarkup(createElement(UpdateProgress, { view: view({ state: "building", log: ["archiving feedface", "vite built"] }) }));
    expect(html.indexOf("Building")).toBeLessThan(html.indexOf("Waiting for bots to finish"));
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain(">vite built</summary>");
    expect(html).toContain("archiving feedface\nvite built");
  });

  it("a press before the first frame shows building, a restart skips it", () => {
    const pressed = renderToStaticMarkup(createElement(UpdateProgress, { view: view({ state: "ready", pending: "apply" }) }));
    expect(pressed).toMatch(/aria-current="step"[^>]*>.*?Building/);
    const restart = renderToStaticMarkup(createElement(UpdateProgress, { view: view({ state: "ready", pending: "restart" }), restart: true }));
    expect(restart).not.toContain("Building");
    expect(restart).toMatch(/aria-current="step"[^>]*>.*?Waiting for bots to finish/);
  });

  it("draining names come from status busyTurns[].botName", () => {
    const busy = busyEntries(view({ status: { ...status, busyTurns: [{ botId: "b1", threadId: "t1", botName: "pipe" }] } }), [{ id: "b1", name: "backend bot" } as unknown as Bot]);
    expect(busy.map((entry) => entry.name)).toEqual(["pipe"]);
  });

  it("a refusal shows its line and the update button stays pressable", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view({ error: "prod moved to 9a1c33e0 since the check found abcdef12; check again" }), busy: [], onApply: noop, onRestart: noop }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("prod moved to 9a1c33e0");
    expect(html).not.toContain('disabled=""');
  });

  it("toast says rolled back with the reason", () => {
    const html = renderToStaticMarkup(createElement(UpdateResultToast, { notice: { key: "k", tone: "warn", title: "Update failed, rolled back to 1.2.0", detail: "health check failed" }, onDismiss: noop }));
    expect(html).toContain("Update failed, rolled back to 1.2.0");
  });
});
