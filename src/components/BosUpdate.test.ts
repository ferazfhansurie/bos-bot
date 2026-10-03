import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { UpdateView } from "@/lib/bos-update";
import { ConfirmUpdateDialog, UpdatePill, UpdatesPanel, UpdateResultToast, busyEntries } from "./BosUpdate";
import type { Bot } from "@/state/store";

vi.mock("./Avatar", () => ({ BotAvatar: () => createElement("span", { "data-avatar": "" }) }));

const status = {
  state: "ready" as const,
  current: { version: "1.2.0", sha: "2d83ba23aaaa" },
  candidate: { version: "1.3.0", sha: "abcdef123456", stagedAt: 1_700_000_000_000, notes: ["Update & restart button"] },
  busyTurns: [{ botId: "b1", threadId: "t1" }],
};
const view = (patch: Partial<UpdateView> = {}): UpdateView => ({ status, state: "ready", offline: false, error: null, pending: null, ...patch });
const noop = () => {};

describe("BosUpdate", () => {
  it("pill hides when idle, says update ready when staged, shows the step while running", () => {
    expect(renderToStaticMarkup(createElement(UpdatePill, { view: view({ state: "idle" }), onOpen: noop }))).toBe("");
    expect(renderToStaticMarkup(createElement(UpdatePill, { view: view(), onOpen: noop }))).toContain("Update ready");
    expect(renderToStaticMarkup(createElement(UpdatePill, { view: view({ state: "stopping" }), onOpen: noop }))).toContain("Pausing bots");
  });

  it("settings names both builds, what's in it, and both buttons", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view(), busy: [], onApply: noop, onRestart: noop }));
    expect(html).toContain("BOS 1.2.0");
    expect(html).toContain("1.3.0 is ready");
    expect(html).toContain("What&#x27;s in it");
    expect(html).toContain("Update &amp; restart");
    expect(html).toContain("Restart");
  });

  it("buttons lock while a run is in progress and the step list shows", () => {
    const html = renderToStaticMarkup(createElement(UpdatesPanel, { view: view({ state: "applying" }), busy: [], onApply: noop, onRestart: noop }));
    expect(html).toContain("Updating to 1.3.0");
    expect(html).toContain('aria-current="step"');
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("confirm sheet lists the busy bots and offers pausing now", () => {
    const bots = [{ id: "b1", name: "bos bot", tasks: [{ threadId: "t1", title: "geng · resume" }] }] as unknown as Bot[];
    const busy = busyEntries(view(), bots);
    expect(busy).toEqual([expect.objectContaining({ name: "bos bot", threadTitle: "geng · resume" })]);
    const html = renderToStaticMarkup(createElement(ConfirmUpdateDialog, { kind: "apply", version: "1.3.0", busy, onConfirm: noop, onCancel: noop }));
    expect(html).toContain("Update to 1.3.0 and restart?");
    expect(html).toContain("bos bot");
    expect(html).toContain("Pause bots now and update");
  });

  it("confirm sheet with nobody busy has no force option", () => {
    const html = renderToStaticMarkup(createElement(ConfirmUpdateDialog, { kind: "restart", busy: [], onConfirm: noop, onCancel: noop }));
    expect(html).toContain("No bots are working right now.");
    expect(html).not.toContain("Pause bots now");
  });

  it("toast says rolled back with the reason", () => {
    const html = renderToStaticMarkup(createElement(UpdateResultToast, { notice: { key: "k", tone: "warn", title: "Rolled back: health check failed", detail: "Still on 1.2.0" }, onDismiss: noop }));
    expect(html).toContain("Rolled back: health check failed");
  });
});
