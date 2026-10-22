import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AnonymousUsageSettings } from "./AnonymousUsageSettings";
const fixture = vi.hoisted(() => ({ usage: undefined as undefined | { enabled: boolean; disabledByEnv?: boolean },
  api: vi.fn(), dispatch: vi.fn(), click: undefined as undefined | (() => void),
}));
vi.mock("@/state/store", () => ({ api: fixture.api, useStore: () => ({
  state: { config: { anonymousUsage: fixture.usage } }, dispatch: fixture.dispatch,
}) }));
vi.mock("./SettingsPrimitives", async importOriginal => {
  const original = await importOriginal<typeof import("./SettingsPrimitives")>();
  return { ...original, Switch: (props: Parameters<typeof original.Switch>[0]) => {
    fixture.click = props.onClick as (() => void) | undefined;
    return createElement(original.Switch, props);
  } };
});
describe("AnonymousUsageSettings", () => {
  it("defaults on and names the payload and destination", () => {
    fixture.usage = undefined;
    const markup = renderToStaticMarkup(createElement(AnonymousUsageSettings));
    expect(markup).toContain('aria-label="share anonymous usage counts"');
    expect(markup).toContain('aria-checked="true"');
    expect(markup).toContain("bos.aihlete.com");
    expect(markup).toContain("No chat, file names, paths, prompts or tokens.");
    expect(markup).toContain("bosbot.my");
    expect(markup).toContain("email, it is sent separately to match a consented signup.");
  });
  it("reflects the server opt-out and environment override", () => {
    fixture.usage = { enabled: false };
    expect(renderToStaticMarkup(createElement(AnonymousUsageSettings))).toContain('aria-checked="false"');
    fixture.usage = { enabled: true, disabledByEnv: true };
    const markup = renderToStaticMarkup(createElement(AnonymousUsageSettings));
    expect(markup).toContain('aria-checked="false"');
    expect(markup).toContain("disabled=\"\"");
    expect(markup).toContain("BOS_NO_PING=1");
  });
  it("clicks save the server setting and hydrate the confirmed response", async () => {
    fixture.usage = { enabled: true };
    const confirmed = { anonymousUsage: { enabled: false, disabledByEnv: false } };
    fixture.api.mockResolvedValueOnce(confirmed);
    renderToStaticMarkup(createElement(AnonymousUsageSettings));
    expect(fixture.click).toBeTypeOf("function");
    fixture.click!();
    expect(fixture.api).toHaveBeenCalledWith("/api/config", {
      method: "PATCH", body: JSON.stringify({ anonymousUsage: { enabled: false } }),
    });
    await vi.waitFor(() => expect(fixture.dispatch).toHaveBeenCalledWith({ type: "configStatus", config: confirmed }));
  });
});
