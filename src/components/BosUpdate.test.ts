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
const view = (patch: Partial<UpdateView> = {}): UpdateView => ({ status, state: "ready", offline: false, error: null, pending: null, checking: false, ...patch });
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

  it("toast says rolled back with the reason", () => {
    const html = renderToStaticMarkup(createElement(UpdateResultToast, { notice: { key: "k", tone: "warn", title: "Update failed, rolled back to 1.2.0", detail: "health check failed" }, onDismiss: noop }));
    expect(html).toContain("Update failed, rolled back to 1.2.0");
  });
});
