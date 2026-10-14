import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/state/store";
import * as store from "@/state/store";
import { AddModelCard, RemoveApiConnection, isApiConnection } from "./AddModelCard";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const render = (element: React.ReactElement, bots: unknown[] = []) => {
  vi.stubGlobal("window", {});
  vi.spyOn(store, "useStore").mockReturnValue({
    state: { ...store.initialState, bots } as never,
    dispatch: vi.fn(), flushBotPatches: vi.fn(), refreshInstances: vi.fn(), refreshModels: vi.fn(),
  } as never);
  return renderToStaticMarkup(createElement(StoreProvider, null, element));
};

describe("Settings → Engines → Add a model", () => {
  it("offers every provider plus any OpenAI-compatible URL, key first", () => {
    const html = render(createElement(AddModelCard));
    expect(html).toContain("Add a model");
    for (const label of ["Anthropic", "OpenAI", "Google Gemini", "xAI", "OpenRouter", "DeepSeek", "Mistral", "Groq", "Other (OpenAI-compatible URL)"]) {
      expect(html).toContain(`>${label}</option>`);
    }
    expect(html).toContain('type="password"');
    expect(html).toContain("Get a key");
    expect(html).toContain("https://console.anthropic.com/settings/keys");
    // No custom URL field until "Other" is picked; Add waits for a key.
    expect(html).not.toContain("API base URL");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*Add<\/button>/s);
  });

  it("only treats added api-key connections as removable, and not while a bot uses one", () => {
    expect(isApiConnection({ instanceId: "api-1a2b3c4d", driverKind: "api-key" })).toBe(true);
    expect(isApiConnection({ instanceId: "openaiCompat", driverKind: "openai-compat" })).toBe(false);
    expect(isApiConnection({ instanceId: "api-1a2b3c4d", driverKind: "claudeAgent" })).toBe(false);
    const instance = { instanceId: "api-1a2b3c4d", driverKind: "api-key" } as store.InstanceInfo;
    expect(render(createElement(RemoveApiConnection, { instance }))).toContain("Remove connection");
    const busy = render(createElement(RemoveApiConnection, { instance }), [{ modelSelection: { instanceId: "api-1a2b3c4d" } }]);
    expect(busy).toContain("A bot uses this connection");
    expect(busy).toContain('disabled=""');
  });
});
