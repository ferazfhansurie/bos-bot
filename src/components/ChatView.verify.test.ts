import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { AppState, Bot, InstanceInfo, Message } from "@/state/store";
import { t } from "@/lib/i18n";
import { askText, runSteps, skillPrompt } from "@/lib/verify-steps";
import { SAVE_RUN_AS_SKILL_LINE } from "../../shared/learn-request";
import type { VerifyCard } from "./VerifyCard";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
  return {
    dispatch: vi.fn(),
    appendComposerDraft: vi.fn(),
    state: null as Partial<AppState> | null,
    verify: null as ComponentProps<typeof VerifyCard> | null,
  };
});
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, ...fixture.state }, dispatch: fixture.dispatch }) };
});
vi.mock("@/lib/drafts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/drafts")>();
  return { ...original, appendComposerDraft: fixture.appendComposerDraft };
});
// The real card renders; its props are kept so a test can press Save.
vi.mock("./VerifyCard", async (importOriginal) => {
  const original = await importOriginal<typeof import("./VerifyCard")>();
  return { VerifyCard: (props: ComponentProps<typeof VerifyCard>) => {
    fixture.verify = props;
    return createElement(original.VerifyCard, props);
  } };
});
// The real useCaptionChrome rides along: it only asks this module for the
// window chrome, and these tests render the desktop-neutral layout.
vi.mock("./DesktopCapabilities", async (importOriginal) => ({
  ...await importOriginal<typeof import("./DesktopCapabilities")>(),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false } }, ready: true }),
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
// The thread controls read live model lists; they are not what this file tests.
vi.mock("./ModelPicker", () => ({ ModelPicker: () => createElement("span", { "data-test-model-control": true }) }));
vi.mock("./ApprovalModeSelector", () => ({ ApprovalModeSelector: () => createElement("span", { "data-test-approval-control": true }) }));

const { ChatView } = await import("./ChatView");
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  fixture.state = null;
  fixture.verify = null;
  vi.clearAllMocks();
});

const bot: Bot = {
  id: "bot", threadId: "t1", name: "Pepper", title: "", description: "", color: "green",
  notifications: true, unread: false, busy: false, messages: [],
  modelSelection: { instanceId: "test", model: "profile-default" },
};
const chip = (id: string, summary: string, ok?: boolean): Message =>
  ({ id, at: 1, role: "bot", kind: "activity", tool: { name: "Bash", summary, ...(ok === undefined ? {} : { ok }) } });
const asked = (id: string, text: string): Message => ({ id, role: "user", kind: "text", at: 1, text });
const run: Message[] = [
  asked("u1", "verify the fixture"),
  chip("c1", "pnpm control:omb doctor --url http://127.0.0.1:8799", true),
  chip("c2", "node --experimental-strip-types scripts/control-omb.ts send --bot x --text hi", false),
  chip("c3", "git status", true),
  chip("c4", "cat scripts/control-omb.ts", true),
];
// A run with no control CLI in it: plain commands, one of them a read.
const release: Message[] = [
  asked("u1", "publish the release"),
  chip("c1", "git push origin main", true),
  chip("c2", "cat CHANGELOG.md", true),
  chip("c3", "gh release create v1.2.0", true),
  chip("c4", "npm publish", true),
];
// An engine with the agents tools, which Save needs alongside the flag.
const agentsEngine = { instanceId: "test", driverKind: "claude", displayName: "Test", capabilities: { agentsMcp: true } } as unknown as InstanceInfo;
const saveable = (): void => {
  fixture.state = { instances: [agentsEngine], config: { features: { skillAuthoring: true } } as AppState["config"] };
};
const CARD = `aria-label="${t("chat.verify.aria")}"`;
const render = (messages: Message[]) => renderToStaticMarkup(createElement(ChatView, { bot: { ...bot, messages } }));
const draft = (): string => fixture.appendComposerDraft.mock.calls[0]![1] as string;

describe("The run card in the chat pane", () => {
  it("stays hidden while the run cannot be saved: no agents engine", () => {
    expect(render(run)).not.toContain(CARD);
  });

  it("stays hidden when skill authoring is switched off in Settings", () => {
    fixture.state = { instances: [agentsEngine], config: { features: { skillAuthoring: false } } as AppState["config"] };
    expect(render(run)).not.toContain(CARD);
  });

  it("shows one folded line once a verified run can be saved; Save fills the composer instead of sending", () => {
    saveable();
    const markup = render(run);
    expect(markup).toContain(CARD);
    expect(markup).toContain("2 steps · 2 verified · 1 failed");
    expect(markup).not.toContain(">doctor<");
    expect(markup).toContain(t("chat.verify.save"));
    expect(fixture.verify?.canSave).toBe(true);
    expect(runSteps(run).map((step) => step.label)).not.toContain("git status");

    fixture.verify!.onSave();
    expect(fixture.appendComposerDraft).toHaveBeenCalledTimes(1);
    expect(fixture.appendComposerDraft).toHaveBeenCalledWith("bot:bot:t1", skillPrompt(runSteps(run), askText(run)));
    expect(draft().startsWith("Create a verification skill from the run below.\nGoal: verify the fixture\n")).toBe(true);
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("shows a run with no control CLI only once it has a few passing steps, and saves it in plain words like /learn", () => {
    saveable();
    expect(render(release.slice(0, 3))).not.toContain(CARD);
    const markup = render(release);
    expect(markup).toContain(CARD);
    expect(markup).toContain("3 steps<");

    fixture.verify!.onSave();
    expect(draft().startsWith(`${SAVE_RUN_AS_SKILL_LINE}\nGoal: publish the release\n`)).toBe(true);
    expect(draft()).not.toContain("/learn");
    expect(draft()).toContain("✓ git push — git push origin main\n");
    expect(draft()).toContain("✓ npm publish — npm publish\n");
    expect(draft()).not.toContain("Create a verification skill");
  });

  it("records only the current ask: the person's next message starts a fresh run", () => {
    saveable();
    expect(render([...run, asked("u2", "now push"), chip("c5", "git push origin main", true)])).not.toContain(CARD);
    expect(render([...run, ...release.slice(0)])).toContain("3 steps<");
  });
});
