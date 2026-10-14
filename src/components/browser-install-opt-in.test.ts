import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeatureFlagConfig } from "@/lib/feature-flags";
import type { Bot, InstanceInfo } from "@/state/store";

const fixture = vi.hoisted(() => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("document", { visibilityState: "visible" });
  vi.stubGlobal("localStorage", { getItem: () => "browser" });
  return { config: {} as FeatureFlagConfig, browserMcp: true, dispatch: vi.fn() };
});

vi.mock("@/lib/analytics", () => ({ analyticsEnabled: () => false, setAnalyticsEnabled: vi.fn() }));

vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return {
    ...original,
    useStore: () => ({
      state: {
        ...original.initialState,
        appSettingsSection: "backups",
        config: { box: { configured: false }, ...fixture.config },
        instances: [{
          instanceId: "fixture", driverKind: "claudeAgent", displayName: "Fixture",
          models: { default: "fixture", options: [] }, snapshot: { state: "available" },
          capabilities: { browserMcp: fixture.browserMcp },
        } as InstanceInfo],
      },
      dispatch: fixture.dispatch,
      flushBotPatches: vi.fn(),
    }),
  };
});

import { SettingsModal } from "./SettingsModal";
import { ComputerPanel } from "./ComputerPanel";
import { AccessSection } from "./bot-settings/AccessSection";
import { useBotSettingsDerived } from "./bot-settings/useBotSettingsDerived";

function BotAccess({ bot }: { bot: Bot }) {
  return createElement(AccessSection, { bot, derived: useBotSettingsDerived(bot) });
}

const bot = { id: "install-fixture", name: "Scout", modelSelection: { instanceId: "fixture" }, browser: false } as Bot;
const switchTag = (markup: string, label: string) => {
  const match = markup.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
  expect(match, `missing switch: ${label}`).not.toBeNull();
  return match![0];
};
const settings = () => renderToStaticMarkup(createElement(SettingsModal));
const access = () => renderToStaticMarkup(createElement(BotAccess, { bot }));
const panel = (browser: boolean) => renderToStaticMarkup(createElement(ComputerPanel, { bot: { ...bot, browser } }));

beforeEach(() => {
  fixture.config = { browserEngine: { kind: "unavailable", installable: true } };
  fixture.browserMcp = true;
  fixture.dispatch.mockClear();
});
afterAll(() => vi.unstubAllGlobals());

describe("browser installation opt-in", () => {
  it("offers no workspace switch in Settings and installs nothing on its own", () => {
    expect(settings()).not.toContain("Enable the built-in browser");
    expect(panel(false)).not.toContain("Install the browser engine");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("lets an explicitly disabled bot opt in on a fresh workspace, while its browser destination stays unavailable", () => {
    const markup = access();
    const toggle = switchTag(markup, "Give this bot a built-in browser");
    expect(toggle).toContain('aria-checked="false"');
    expect(toggle).not.toContain("disabled=");
    expect(markup.match(/<button[^>]*>Browser<\/button>/)?.[0]).toContain("disabled=");
    expect(panel(false)).not.toContain("Install the browser engine");
    expect(panel(true)).toContain("Install the browser engine");
    expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it("still honours a saved workspace opt-out", () => {
    fixture.config.features = { browser: false };
    expect(switchTag(access(), "Give this bot a built-in browser")).toContain("disabled=");
  });

  it("keeps the bot opt-in unavailable when the server cannot install the engine", () => {
    fixture.config.browserEngine = { kind: "unavailable", installable: false, reason: "Unsupported platform" };
    expect(switchTag(access(), "Give this bot a built-in browser")).toContain("disabled=");
    expect(panel(true)).not.toContain("Install the browser engine");
  });

  it("preserves the per-bot provider capability gate", () => {
    fixture.browserMcp = false;
    expect(switchTag(access(), "Give this bot a built-in browser")).toContain("disabled=");
  });
});
