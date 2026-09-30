import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { selectTailnetOrigin } from "./tailnet-origin.ts";

const { run, exists } = vi.hoisted(() => ({ run: vi.fn(), exists: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(), existsSync: exists,
}));

beforeEach(() => {
  vi.resetModules();
  run.mockReset();
  exists.mockReset();
  exists.mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

const running = (dns: string) => ({ stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: dns } }) });

it("stops immediately after a matching client without probing later candidates", async () => {
  run.mockImplementation(async binary => {
    if (binary === "/Applications/Tailscale.app/Contents/MacOS/Tailscale") return running("local.team-a.ts.net.");
    throw new Error("later candidate must not run");
  });
  const { tailnetOrigin } = await import("./tailnet-origin.ts");
  expect(await tailnetOrigin("https://peer.team-a.ts.net")).toBe("https://local.team-a.ts.net:8443");
  expect(run).toHaveBeenCalledTimes(1);
});

it("uses remaining shared budget and stops after a timed-out child consumes it", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  run.mockImplementation(async () => {
    now += run.mock.calls.length === 1 ? 1500 : 3500;
    throw new Error("ETIMEDOUT");
  });
  const { tailnetOrigin } = await import("./tailnet-origin.ts");
  expect(await tailnetOrigin("https://peer.team-a.ts.net")).toBeNull();
  expect(run).toHaveBeenCalledTimes(2);
  expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([5000, 3500]);
  expect(run.mock.calls.every(([, , options]) => options.killSignal === "SIGKILL")).toBe(true);
});

it("still reaches a later Windows client when earlier failures and wrong-tailnet probes are quick", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  run.mockImplementation(async binary => {
    now += 100;
    if (binary === "C:\\Program Files\\Tailscale\\tailscale.exe") return running("partnerhost.example-tailnet.ts.net.");
    if (binary === "/usr/local/bin/tailscale") return running("wrong.other-tail.ts.net.");
    throw new Error("ENOENT");
  });
  const { tailnetOrigin } = await import("./tailnet-origin.ts");
  expect(await tailnetOrigin("https://firaz.example-tailnet.ts.net")).toBe("https://partnerhost.example-tailnet.ts.net:8443");
  expect(run).toHaveBeenCalledTimes(7);
  expect(run.mock.calls.map(([, , options]) => options.timeout)).toEqual([5000, 4900, 4800, 4700, 4600, 4500, 4400]);
});

it("finds the running Windows Program Files client on the peer tailnet", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1000);
  const windows = "C:\\Program Files\\Tailscale\\tailscale.exe";
  exists.mockImplementation(binary => binary === windows);
  run.mockImplementation(async binary => {
    if (binary === windows) return running("partnerhost.example-tailnet.ts.net.");
    throw new Error("ENOENT");
  });
  const { tailnetOrigin } = await import("./tailnet-origin.ts");
  expect(await tailnetOrigin("https://firaz.example-tailnet.ts.net")).toBe("https://partnerhost.example-tailnet.ts.net:8443");
  expect(run).toHaveBeenCalledWith(windows, ["status", "--json"], expect.objectContaining({
    timeout: 5000, maxBuffer: 512000, env: expect.objectContaining({ TAILSCALE_BE_CLI: "1" }),
  }));
});

it("finds Linux /usr/bin and PATH clients without gating PATH with existsSync", async () => {
  for (const available of ["/usr/bin/tailscale", "tailscale"]) {
    vi.resetModules();
    run.mockReset();
    exists.mockImplementation(binary => binary === available && binary !== "tailscale");
    run.mockImplementation(async binary => {
      if (binary === available) return running("linux.team-a.ts.net.");
      throw new Error("ENOENT");
    });
    const { tailnetOrigin } = await import("./tailnet-origin.ts");
    expect(await tailnetOrigin("https://peer.team-a.ts.net")).toBe("https://linux.team-a.ts.net:8443");
    expect(exists).not.toHaveBeenCalledWith("tailscale");
  }
});

it("collects multiple clients and caches separately per peer tailnet", async () => {
  run.mockImplementation(async binary => {
    if (binary === "/usr/local/bin/tailscale") return running("local.team-b.ts.net.");
    if (binary === "tailscale") return running("local.team-a.ts.net.");
    throw new Error("ENOENT");
  });
  const { tailnetOrigin } = await import("./tailnet-origin.ts");
  expect(await tailnetOrigin("https://peer.team-a.ts.net")).toBe("https://local.team-a.ts.net:8443");
  const calls = run.mock.calls.length;
  expect(await tailnetOrigin("https://other.team-a.ts.net")).toBe("https://local.team-a.ts.net:8443");
  expect(run).toHaveBeenCalledTimes(calls);
  expect(await tailnetOrigin("https://peer.team-b.ts.net")).toBe("https://local.team-b.ts.net:8443");
  expect(run.mock.calls.length).toBeGreaterThan(calls);
  expect(await tailnetOrigin("https://peer.team-c.ts.net")).toBeNull();
});

it("fails closed for invalid peers, stopped clients, malformed JSON and CLI failures", async () => {
  const { tailnetOrigin } = await import("./tailnet-origin.ts");
  expect(await tailnetOrigin("not a URL")).toBeNull();
  expect(await tailnetOrigin("https://public.example.com")).toBeNull();
  expect(run).not.toHaveBeenCalled();
  run.mockImplementation(async binary => {
    if (binary === "/usr/bin/tailscale") return { stdout: "null" };
    if (binary === "tailscale") return { stdout: JSON.stringify({ BackendState: "Stopped", Self: { DNSName: "local.team-a.ts.net." } }) };
    if (binary === "/usr/local/bin/tailscale") return { stdout: "broken JSON" };
    throw new Error("ETIMEDOUT");
  });
  expect(await tailnetOrigin("https://peer.team-a.ts.net")).toBeNull();
  for (const [, , options] of run.mock.calls) {
    expect(options).toMatchObject({ maxBuffer: 512000, killSignal: "SIGKILL" });
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(5000);
  }
  const calls = run.mock.calls.length;
  expect(await tailnetOrigin("https://peer.team-a.ts.net")).toBeNull();
  expect(run).toHaveBeenCalledTimes(calls);
});

it("selects only a Running client on the peer tailnet", () => {
  const statuses = [
    { BackendState: "Stopped", Self: { DNSName: "wrong.team-a.ts.net." } },
    { BackendState: "Running", Self: { DNSName: "firaz.team-b.ts.net." } },
    { BackendState: "Running", Self: { DNSName: "firaz.team-a.ts.net." } },
  ];
  expect(selectTailnetOrigin(statuses, "https://putri.team-a.ts.net")).toBe("https://firaz.team-a.ts.net:8443");
  expect(selectTailnetOrigin(statuses, "https://putri.team-c.ts.net")).toBeNull();
});
