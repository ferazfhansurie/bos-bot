import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

test("anonymous usage setting persists through the real server and env override wins", async () => {
  const fixture = await launchVerificationServer();
  async function config(enabled?: boolean) {
    const response = await fetch(`${fixture.info.url}/api/config`, {
      method: enabled === undefined ? "GET" : "PATCH",
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(enabled === undefined ? {} : { body: JSON.stringify({ anonymousUsage: { enabled } }) }),
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.ok).toBe(true);
    return response.json() as Promise<{ anonymousUsage: { enabled: boolean; disabledByEnv: boolean } }>;
  }
  try {
    expect((await config()).anonymousUsage).toEqual({ enabled: true, disabledByEnv: true });
    expect((await config(false)).anonymousUsage).toEqual({ enabled: false, disabledByEnv: true });
    expect((await config()).anonymousUsage.enabled).toBe(false);
    const saved = JSON.parse(await readFile(join(fixture.info.dataDir, "config.json"), "utf8"));
    expect(saved.anonymousUsage).toEqual({ enabled: false });
    expect((await config(true)).anonymousUsage).toEqual({ enabled: true, disabledByEnv: true });
    // Even a default-on fixture remains hermetic; no id or attempt is created.
    await expect(readFile(join(fixture.info.dataDir, "anonymous-usage.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const health = await fetch(`${fixture.info.url}/api/health`);
    expect(health.ok).toBe(true);
  } finally { await fixture.close(); }
}, 60_000);
