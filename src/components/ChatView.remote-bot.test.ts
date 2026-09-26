import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Bot, InstanceInfo, Message } from "@/state/store";
import type { Pending } from "./PendingApproval";

// Same harness as ChatView.controls.test.ts: static render, stubbed store.
vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({
    state: { ...original.initialState, instances: [{ instanceId: "test", driverKind: "codex", displayName: "Test" } as InstanceInfo] },
    dispatch: vi.fn(),
  }) };
});
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { packaged: true } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span", { "data-test-model-control": true }) }));

const { ChatView } = await import("./ChatView");
const { PendingApprovalActions } = await import("./PendingApproval");
afterAll(() => vi.unstubAllGlobals());

// Two user messages with the same parent are two versions of one turn.
const messages: Message[] = [
  { id: "v1", role: "user", kind: "text", at: 1, text: "first try" },
  { id: "v2", role: "user", kind: "text", at: 2, text: "second try" },
];

const local: Bot = {
  id: "bot", threadId: "selected", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages,
  modelSelection: { instanceId: "test", model: "profile-default" },
  tasks: [{ threadId: "selected", title: "Selected", createdAt: 1, busy: false, activity: "idle",
    modelSelection: { instanceId: "test", model: "thread-model" }, approvalMode: "ask" }],
};
const remote: Bot = {
  ...local,
  id: "rb-abc123-bot",
  remote: { homeId: "home-1", homeName: "Studio", ownerName: "Putri" },
};

function approval(): Pending {
  const message: Message = {
    id: "approval-card", role: "bot", kind: "options", at: 3,
    card: { title: "Approval needed", subtitle: "pnpm test", options: ["Allow", "Deny"], requestId: "req", tool: "Bash" },
  };
  return { message, requestId: "req", tool: "Bash", allowKey: "Bash:pnpm test", detail: "pnpm test" };
}

describe("remote bot controls in the chat view", () => {
  it("hides settings, computer and inspector entry points for a relayed bot", () => {
    const markup = renderToStaticMarkup(createElement(ChatView, { bot: remote }));
    expect(markup).toContain("on Putri&#x27;s Mac");
    expect(markup).not.toContain("data-test-model-control");
    expect(markup).not.toContain('data-tour="computer"');
    expect(markup).not.toContain('aria-label="Inspector"');
    expect(markup).not.toContain("Rename Pepper");
  });

  it("keeps message edit and version arrows for a relayed bot, like a local one", () => {
    for (const bot of [local, remote]) {
      const markup = renderToStaticMarkup(createElement(ChatView, { bot }));
      expect(markup).toContain('aria-label="Edit message"');
      expect(markup).toMatch(/[12]\/2/);
    }
  });

  it("offers Always allow on approvals only for a local bot", () => {
    const render = (bot: Bot) => renderToStaticMarkup(createElement(PendingApprovalActions, {
      pending: approval(), threadId: "selected", bot, onCancelTurn: () => undefined,
    }));
    const localMarkup = render(local);
    expect(localMarkup).toContain("Always allow");
    const remoteMarkup = render(remote);
    expect(remoteMarkup).not.toContain("Always allow");
    expect(remoteMarkup).toContain("Deny");
    expect(remoteMarkup).toContain("Allow once");

    const sessionPending = { ...approval(), allowKey: undefined, allowSession: true };
    const sessionRender = (bot: Bot) => renderToStaticMarkup(createElement(PendingApprovalActions, {
      pending: sessionPending, threadId: "selected", bot, onCancelTurn: () => undefined,
    }));
    expect(sessionRender(local)).toContain("Always allow this session");
    expect(sessionRender(remote)).not.toContain("Always allow");
  });
});
