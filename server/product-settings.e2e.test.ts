import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";

test("real product routes respect the fixture optout and refuse fabricated completion", async () => {
  const fixture = await launchVerificationServer({ BOS_FIXTURE_STARTUP_TIMEOUT_MS: "90000" });
  const call = async (path: string, body?: unknown) => fetch(`${fixture.info.url}${path}`, {
    method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", origin: fixture.info.url },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  try {
    const response = await call("/api/product"); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ analyticsEnabled: false, referralUrl: null, config: { version: 1 } });
    expect((await call("/api/app-config")).status).toBe(200);
    expect((await call("/api/product/events", { events: [{ name: "message_sent", props: { prompt: "must stay local" } }] })).status).toBe(200);
    expect((await call("/api/product/events", { events: Array(51).fill({ name: "open" }) })).status).toBe(400);
    expect((await call("/api/product/job-done", { confirmed: true })).status).toBe(409);
    expect((await call("/api/product/claim", { email: "test-213@example.invalid" })).status).toBe(503);
    expect((await call("/api/product/feedback", { text: "test fixture" })).status).toBe(503);
    await expect(readFile(join(fixture.info.dataDir, "anonymous-usage.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const health = await call("/api/health"); expect(health.ok).toBe(true);
  } finally { await fixture.close(); }
}, 120_000);
