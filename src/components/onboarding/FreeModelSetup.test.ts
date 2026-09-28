import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as store from "@/state/store";
import { FreeModelSetup } from "./FreeModelSetup";
import { InstanceProviderMark, ProviderMark } from "@/components/ProviderIcons";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const render = (element: React.ReactElement) => { vi.stubGlobal("window", {}); return renderToStaticMarkup(element); };
const DEEPSEEK = "#5786FE";

describe("BOS Free presentation", () => {
  it("names the model and shows its mark before connecting", () => {
    vi.spyOn(store, "useStore").mockReturnValue({ state: store.initialState, dispatch: vi.fn() } as unknown as ReturnType<typeof store.useStore>);
    const html = render(createElement(FreeModelSetup));
    expect(html).toContain("powered by DeepSeek V4 Flash");
    expect(html).toContain("100 messages a day");
    expect(html).toContain(DEEPSEEK);
    expect(html).not.toContain("zero-price");
  });
  it("hosted instances use the DeepSeek preset; bring-your-own keys fall back to the OpenRouter mark", () => {
    expect(render(createElement(InstanceProviderMark, { instance: { driverKind: "openrouter-free", icon: { kind: "preset", preset: "deepseek" } } }))).toContain(DEEPSEEK);
    const byo = render(createElement(ProviderMark, { driverKind: "openrouter-free" }));
    expect(byo).toContain("<svg");
    expect(byo).toContain("#94A3B8");
  });
});
