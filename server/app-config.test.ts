import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AppConfigClient } from "./app-config.ts";

it("caches validated config, survives offline launches, and retains good cache on invalid schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bos-app-config-"));
  try {
    const request = vi.fn(async () => Response.json({ version: 1, flags: { plans: false } }));
    const client = new AppConfigClient({ dataDir: dir, fetch: request });
    expect(client.current().minVersion.desktop).toBe("0.0.0");
    await client.refresh();
    expect(client.current().flags.plans).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "app-config.json"), "utf8")).version).toBe(1);
    const offline = new AppConfigClient({ dataDir: dir, fetch: vi.fn(async () => { throw Error("offline"); }) });
    await offline.refresh();
    expect(offline.current().flags.plans).toBe(false);
    const future = new AppConfigClient({ dataDir: dir, fetch: vi.fn(async () => Response.json({ version: 2 })) });
    await future.refresh();
    expect(future.current().flags.plans).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
