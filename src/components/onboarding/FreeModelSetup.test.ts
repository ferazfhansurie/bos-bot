import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { FreeModelSetup } from "./FreeModelSetup";
import { InstanceProviderMark, ProviderMark } from "@/components/ProviderIcons";
import * as productConfig from "@/lib/app-config";
import { DEFAULT_APP_CONFIG } from "../../../shared/app-config";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const render = (element: React.ReactElement) => { vi.stubGlobal("window", {}); return renderToStaticMarkup(element); };
const DEEPSEEK = "#5786FE";

describe("BOS Free presentation", () => {
  it("hides both full and compact setup when the free-engine flag is off", () => {
    vi.spyOn(store, "useStore").mockReturnValue({ state: store.initialState, dispatch: vi.fn() } as unknown as ReturnType<typeof store.useStore>);
    vi.spyOn(productConfig, "useAppConfig").mockReturnValue({ ...DEFAULT_APP_CONFIG, flags: { ...DEFAULT_APP_CONFIG.flags, freeEngine: false } });
    expect(render(createElement(FreeModelSetup))).toBe("");
    expect(render(createElement(FreeModelSetup, { compact: true }))).toBe("");
  });
  it("offers BOS Free without promising a model or quota the server has not supplied", () => {
    vi.spyOn(store, "useStore").mockReturnValue({ state: store.initialState, dispatch: vi.fn() } as unknown as ReturnType<typeof store.useStore>);
    const html = render(createElement(FreeModelSetup));
    expect(html).toContain("BOS Free");
    expect(html).toContain("No Claude or ChatGPT subscription needed");
    expect(html).toContain('href="https://app.bosbot.my/portal?start=free"');
    expect(html).toContain("Create free account");
    expect(html).not.toContain("100 messages a day");
    expect(html).not.toContain("DeepSeek V4 Flash");
    expect(html).not.toContain("zero-price");
  });
  it("hosted instances use the DeepSeek preset; bring-your-own keys fall back to the OpenRouter mark", () => {
    expect(render(createElement(InstanceProviderMark, { instance: { driverKind: "openrouter-free", icon: { kind: "preset", preset: "deepseek" } } }))).toContain(DEEPSEEK);
    const byo = render(createElement(ProviderMark, { driverKind: "openrouter-free" }));
    expect(byo).toContain("<svg");
    expect(byo).toContain("#94A3B8");
  });
});
