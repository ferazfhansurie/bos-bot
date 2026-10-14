import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiKeyDriver } from "./api-key.ts";

const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const create = (config: Record<string, unknown>) => ApiKeyDriver.create({
  instanceId: "api-fixture", displayName: "Fixture", enabled: true,
  config: ApiKeyDriver.decodeConfig(config),
  environment: { OPENAI_COMPAT_API_KEY: "must-not-use", OPENAI_API_KEY: "must-not-use" },
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("API key driver (Settings → Engines → Add a model)", () => {
  it("accepts only url, key, model and tools, and a safe base URL", () => {
    expect(ApiKeyDriver.decodeConfig({ url: "https://api.x.ai/v1/", key: "k", model: "grok-5" })).toEqual({ url: "https://api.x.ai/v1", key: "k", model: "grok-5" });
    for (const bad of [null, {}, { url: "http://example.com/v1" }, { url: "https://a.b/v1", apiKeyEnv: "OTHER" }, { url: "https://a.b/v1", provider: "x" }, { url: "https://a.b/v1", tools: "yes" }]) {
      expect(() => ApiKeyDriver.decodeConfig(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("lists every model on the key and chats with only the saved key", async () => {
    const fetch = vi.fn(async (url: unknown) => String(url).endsWith("/models")
      ? response({ data: [{ id: "claude-opus-5", display_name: "Claude Opus 5" }, { id: "claude-sonnet-5" }] })
      : response({ choices: [{ message: { content: "ok" } }] }));
    vi.stubGlobal("fetch", fetch);
    const inst = await create({ url: "https://api.anthropic.com/v1", key: "sk-ant-fixture", model: "claude-sonnet-5" });
    await vi.waitFor(() => expect(inst.models.options.map((option) => option.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]));
    expect(inst.models.default).toBe("claude-sonnet-5");
    expect(inst.models.options[0]).toEqual({ id: "claude-opus-5", label: "Claude Opus 5" });
    expect(await inst.generateText!("synthetic")).toBe("ok");
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    const models = calls.find(([url]) => url.endsWith("/models"))!;
    // Anthropic's own /models reads x-api-key; its OpenAI-compatible chat reads Bearer.
    expect(models[1].headers).toMatchObject({ authorization: "Bearer sk-ant-fixture", "x-api-key": "sk-ant-fixture" });
    const chat = calls.find(([url]) => url.endsWith("/chat/completions"))!;
    expect(chat[0]).toBe("https://api.anthropic.com/v1/chat/completions");
    expect(JSON.parse(String(chat[1].body)).model).toBe("claude-sonnet-5");
    expect(JSON.stringify(calls)).not.toContain("must-not-use");
    await inst.dispose();
  });

  it("keeps the saved model when the list fails, and is unavailable without a key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "nope" }, 401)));
    const inst = await create({ url: "https://api.openai.com/v1", key: "sk-fixture", model: "gpt-6" });
    await inst.refreshModels?.().catch(() => {});
    expect(inst.models).toEqual({ default: "gpt-6", options: [{ id: "gpt-6", label: "gpt-6" }] });
    await inst.dispose();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const keyless = await create({ url: "https://api.openai.com/v1", model: "gpt-6" });
    expect((await keyless.snapshot()).state).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
    await keyless.dispose();
  });
});
