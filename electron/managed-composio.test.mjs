import { describe, expect, it, vi } from "vitest";
import {
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
  resolveManagedComposioBrokerUrl,
  desktopComposioBrokerUrl,
  HOSTED_COMPOSIO_BROKER_URL,
} from "./managed-composio.mjs";

const TOKEN = "a".repeat(64);

describe("managed Composio desktop registration", () => {
  it("has no hosted broker default and prefers BOS_COMPOSIO_BROKER_URL", () => {
    expect(resolveManagedComposioBrokerUrl({})).toBe("");
    expect(resolveManagedComposioBrokerUrl({ OMB_COMPOSIO_BROKER_URL: "https://legacy.example/" })).toBe(
      "https://legacy.example",
    );
    expect(
      resolveManagedComposioBrokerUrl({
        BOS_COMPOSIO_BROKER_URL: "https://broker.example/root/",
        OMB_COMPOSIO_BROKER_URL: "https://legacy.example",
      }),
    ).toBe("https://broker.example/root");
    expect(resolveManagedComposioBrokerUrl({ BOS_COMPOSIO_BROKER_URL: "http://broker.example" })).toBe("");
  });

  it("packaged desktop defaults to the hosted broker; env, then preset, win; =off disables", () => {
    expect(HOSTED_COMPOSIO_BROKER_URL).toBe("https://bosbot.my/composio");
    expect(desktopComposioBrokerUrl({ environment: {} })).toBe(HOSTED_COMPOSIO_BROKER_URL);
    expect(desktopComposioBrokerUrl({ environment: {}, presetUrl: "https://preset.example/b/" })).toBe("https://preset.example/b");
    expect(desktopComposioBrokerUrl({ environment: {}, presetUrl: "http://evil.example" })).toBe(HOSTED_COMPOSIO_BROKER_URL);
    expect(
      desktopComposioBrokerUrl({ environment: { BOS_COMPOSIO_BROKER_URL: "https://own.example" }, presetUrl: "https://preset.example" }),
    ).toBe("https://own.example");
    for (const off of ["off", "OFF", "0", "none", "false"]) {
      expect(desktopComposioBrokerUrl({ environment: { BOS_COMPOSIO_BROKER_URL: off }, presetUrl: "https://preset.example" })).toBe("");
    }
    expect(desktopComposioBrokerUrl({ environment: { OMB_COMPOSIO_BROKER_URL: "off" } })).toBe("");
  });

  it("sends the anonymous install id, and only a well-formed one, when registering", async () => {
    const id = "0f8b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
    for (const [installId, expected] of [[id, { install: id }], [id.toUpperCase(), { install: id }], ["nope", {}], [undefined, {}]]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ installationId: "i", token: TOKEN }), { status: 201 }));
      await ensureManagedComposioCredentials({ brokerUrl: "https://broker.example", credentials: {}, fetchImpl, saveCredentials: async () => {}, installId });
      expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual(expected);
    }
  });

  it("publishes only a complete broker credential", () => {
    expect(managedComposioAccess("https://broker.example/", { composioBrokerToken: TOKEN })).toEqual({
      url: "https://broker.example",
      token: TOKEN,
    });
    expect(managedComposioAccess("https://broker.example", {})).toBeNull();
    expect(managedComposioAccess("", { composioBrokerToken: TOKEN })).toBeNull();
  });

  it("accepts HTTPS and loopback development brokers but rejects insecure remote URLs", async () => {
    expect(normalizeManagedComposioBrokerUrl("https://broker.example/root/")).toBe(
      "https://broker.example/root",
    );
    expect(normalizeManagedComposioBrokerUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://[::1]:8787/")).toBe(
      "http://[::1]:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://user:secret@broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://broker.example?redirect=evil")).toBe("");

    const fetchImpl = vi.fn();
    const credentials = { composioBrokerToken: TOKEN };
    await ensureManagedComposioCredentials({
      brokerUrl: "http://broker.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(managedComposioAccess("http://broker.example", credentials)).toBeNull();
    expect(
      managedComposioChildEnvironment("http://broker.example", credentials, {
        PATH: "/usr/bin",
        OMB_COMPOSIO_BROKER_URL: "http://attacker.example",
        OMB_COMPOSIO_BROKER_TOKEN: "attacker-controlled",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(
      managedComposioChildEnvironment("http://[::1]:8787", credentials, { PATH: "/usr/bin" }),
    ).toEqual({
      PATH: "/usr/bin",
      OMB_COMPOSIO_BROKER_URL: "http://[::1]:8787",
      OMB_COMPOSIO_BROKER_TOKEN: TOKEN,
    });
  });

  it("registers a new installation and persists it", async () => {
    const credentials = {};
    const saveCredentials = vi.fn(async () => {});
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: TOKEN, installationId: "installation-test" }),
    }));

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example/v1/installations",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).toHaveBeenCalledWith(credentials);
  });

  it("settles a stalled optional registration without storing partial credentials", async () => {
    vi.useFakeTimers();
    try {
      const credentials = {};
      const saveCredentials = vi.fn(async () => {});
      const log = vi.fn();
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      );
      const operation = ensureManagedComposioCredentials({
        brokerUrl: "https://broker.example",
        credentials,
        fetchImpl,
        saveCredentials,
        log,
        registrationTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(operation).resolves.toBe(credentials);
      expect(credentials).toEqual({});
      expect(saveCredentials).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("registration failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a valid installation identity during a transient broker outage", async () => {
    const credentials = {
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    };
    const saveCredentials = vi.fn(async () => {});

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
      saveCredentials,
    });

    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).not.toHaveBeenCalled();
  });
});
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
