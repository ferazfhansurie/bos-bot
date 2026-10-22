// Explicit release verification only: builds the real sender into a temporary
// dev bundle, posts one content-free test event, and removes its own data.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
if (!process.argv.includes("--send")) throw Error("Pass --send to explicitly send one test-213 event to bosbot.my.");
const dataDir = await mkdtemp(join(tmpdir(), "bos-213-dev-sender-"));
try {
  const entry = join(dataDir, "sender.mjs");
  await build({ entryPoints: ["server/product-telemetry.ts"], outfile: entry, bundle: true, platform: "node", format: "esm", target: "node24" });
  const { ProductTelemetry } = await import(pathToFileURL(entry).href);
  const install_id = `test-213-dev-${Date.now()}`;
  const sender = new ProductTelemetry({ dataDir, env: {}, enabled: () => true, version: () => "2.1.3", platform: process.platform, testInstallId: install_id });
  assert.equal(sender.track("open", { source: "desktop" }), true);
  await sender.flush();
  const queue = JSON.parse(await readFile(join(dataDir, "product-events.json"), "utf8"));
  assert.equal(queue.queue.length, 0, "The public receiver did not acknowledge the dev batch.");
  await sender.stop();
  console.log(JSON.stringify({ ok: true, install_id, event: "open", source: "bundled dev sender", accepted: true }));
} finally { await rm(dataDir, { recursive: true, force: true }); }
