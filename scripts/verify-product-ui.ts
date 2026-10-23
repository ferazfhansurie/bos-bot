// Real conversion components; every mutation is intercepted inside this
// disposable preview. No payment, relay registration or feedback leaves it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DEFAULT_APP_CONFIG } from "../shared/app-config.ts";
import { closeBrowserSession } from "../server/browser-engine.ts";
import { removeTempDir } from "../server/testing/cleanup.ts";
import { ensureUiBrowser, runControlOmbUi, sessionEnv, type UiHandle } from "./testing/control-omb-ui.ts";
import { mountPreview, type MountedPreview } from "./testing/preview-fixture.ts";

const runFile = promisify(execFile);
const records: { path: string; body: unknown }[] = [];
const config = structuredClone(DEFAULT_APP_CONFIG);
config.banner = { id: "fixture", text: "Synthetic product announcement", url: "https://bosbot.my/get" };
const instances = ["claude", "codex"].map(id => ({ instanceId: id, driverKind: id === "claude" ? "claudeAgent" : "codex", displayName: id === "claude" ? "Claude" : "ChatGPT", snapshot: { state: "available", authenticated: false }, models: { default: "fixture", options: [] }, install: { command: { darwin: "echo fixture" } } }));
const json = (res: ServerResponse, value: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
const body = async (req: IncomingMessage) => {
  let value = "";
  for await (const chunk of req) { value += String(chunk); if (value.length > 8192) throw new Error("Fixture request too large"); }
  return JSON.parse(value);
};
// This fixture verifies renderer behavior only. It deliberately has no real
// engine, billing, account, or telemetry service behind the synthetic API.
const dataDir = mkdtempSync(join(tmpdir(), "bos-product-ui-"));
const logPath = join(tmpdir(), `bos-product-ui-${Date.now()}.jsonl`);
writeFileSync(logPath, "", { mode: 0o600 });
const backend = createServer((req, res) => {
  appendFileSync(logPath, JSON.stringify({ method: req.method, path: req.url }) + "\n");
  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "GET") return json(res, { error: "Unhandled mutations are forbidden in this isolated preview." }, 403);
  if (path === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(': isolated preview\n\n'); return; }
  if (path === "/api/bots") return json(res, { bots: [], groups: [], sections: [] });
  if (path === "/api/config") return json(res, { profile: { name: "", email: "" }, onboarding: {}, features: {} });
  if (path === "/api/routines") return json(res, { routines: [], runs: [] });
  if (path === "/api/webhooks") return json(res, { webhooks: [], attempts: [], ingress: [] });
  if (path === "/api/activity") return json(res, { items: [] });
  return json(res, { count: 0 });
});
await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
const address = backend.address();
if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
const fixture = { info: { url: `http://127.0.0.1:${address.port}`, dataDir, logPath }, close: async () => {
  await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections(); });
  await removeTempDir(dataDir);
} };
let preview: MountedPreview | undefined;
let opened: { binary: string; env: NodeJS.ProcessEnv } | undefined;
try {
  preview = await mountPreview(fixture, {
    entry: "/scripts/testing/product-preview.tsx", route: "/__product.html", title: "Isolated BOS conversion UI", logLevel: "warn",
    extraRoutes: [
      { path: "/api/product", method: "GET", handler: (_req, res) => json(res, { config, referralUrl: "https://bosbot.my/get?ref=fixture-only" }) },
      { path: "/api/instances", method: "GET", handler: (_req, res) => json(res, { instances }) },
      { path: /^\/api\/(?:product\/(?:feedback|job-done)|onboarding\/free-model)$/, method: "POST", handler: async (req, res) => {
        records.push({ path: req.url!, body: await body(req) });
        if (req.url === "/api/onboarding/free-model") return json(res, { error: "Synthetic relay unavailable" }, 503);
        return json(res, { ok: true });
      } },
    ],
  });
  const { binary, chrome } = await ensureUiBrowser();
  const handle: UiHandle = { url: fixture.info.url, previewUrl: preview.previewUrl, session: `p${new URL(fixture.info.url).port}`, binary, chrome, home: fixture.info.dataDir, botId: "fixture-only", logPath: fixture.info.logPath };
  const env = sessionEnv(handle);
  mkdirSync(join(handle.home, "tmp"), { recursive: true });
  opened = { binary, env };
  // Navigate asynchronously and wait for the actual controls below, rather
  // than the browser CLI's short generic page-load timeout during cold Vite.
  await runFile(binary, ["open", "--json"], { env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 });
  await runFile(binary, ["eval", `setTimeout(() => location.assign(${JSON.stringify(preview.previewUrl)}), 0); true`, "--json"], { env, timeout: 30_000 });
  const handlePath = join(handle.home, "product-ui.json");
  writeFileSync(handlePath, JSON.stringify(handle), { mode: 0o600 });
  const ui = (verb: string, ...args: string[]) => runControlOmbUi([verb, "--ui", handlePath, ...args]) as Promise<any>;
  const click = (name: string) => ui("click", "--name", name);
  const evaluate = async (code: string) => (await ui("eval", "--js", code)).result;
  const wait = async (code: string) => {
    const until = Date.now() + 120_000;
    for (;;) {
      try { if (await evaluate(code)) return; } catch { /* a navigation can replace the execution context */ }
      if (Date.now() > until) throw new Error(`UI did not settle: ${code}`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  await wait('document.body.innerText.includes("BOS AI") && !!document.querySelector("input[aria-label=\\"Your BOS invitation link\\"]")');
  assert.equal(records.length, 0, "render must never submit feedback, activation or a relay request");
  assert.equal(await evaluate('document.querySelector("aside[aria-label=\\"BOS announcement\\"] a").textContent'), "Synthetic product announcement");
  await click("View plans");
  assert.match(await evaluate("document.body.innerText"), /RM20/);
  assert.match(await evaluate("document.body.innerText"), /RM1,500/);
  assert.equal(await evaluate('[...document.querySelectorAll("a")].some(a => a.textContent.includes("Cloud founding"))'), false);
  assert.equal(await evaluate('document.querySelector("input[aria-label=\\"Your BOS invitation link\\"]").value'), "https://bosbot.my/get?ref=fixture-only");
  await click("Open support");
  await ui("type", "--name", "Your feedback", "--text", "Fixture-only suggestion");
  assert.equal(await evaluate('document.querySelector("[role=dialog] form button[type=submit]").disabled'), true);
  assert.equal(records.length, 0);
  await click("Share this note with Firaz");
  await click("Send feedback");
  await wait('document.body.innerText.includes("feedback was sent")');
  assert.deepEqual(records, [{ path: "/api/product/feedback", body: { text: "Fixture-only suggestion" } }]);
  await click("Close");
  await click("Good response");
  assert.equal(records.length, 1, "local reaction must not share a rating automatically");
  await click("Share this rating with Firaz");
  await click("Send feedback");
  await wait('document.body.innerText.includes("feedback was sent")');
  assert.deepEqual(records[1], { path: "/api/product/feedback", body: { text: "", rating: "up" } });
  await click("Close");
  await click("BOS completed a useful task for me");
  await click("Confirm useful result");
  await wait('document.body.innerText.includes("useful result is recorded")');
  assert.deepEqual(records[2], { path: "/api/product/job-done", body: { confirmed: true } });
  // Inspect the signup target without opening an external account flow.
  assert.equal(await evaluate('[...document.querySelectorAll("a")].find(a => a.textContent === "Create free account").href'), "https://app.bosbot.my/portal?start=free");
  assert.equal(records.length, 3, "offering signup must not register a legacy install grant");
  await click("Use my own OpenRouter key");
  await ui("type", "--name", "OpenRouter API key", "--text", "synthetic-fixture-key");
  await click("Connect and continue free");
  await wait('document.body.innerText.includes("Could not connect. Check your OpenRouter key")');
  assert.deepEqual(records[3], { path: "/api/onboarding/free-model", body: { key: "synthetic-fixture-key" } });
  await wait('document.querySelector("section[aria-label=\\"Free models\\"] form button[type=submit]")?.disabled === false');
  await click("Cancel");
  const screenshots = join(process.cwd(), ".omb-scratch", "product-ui");
  await evaluate("window.scrollTo(0, 0)");
  await ui("screenshot", "--out", join(screenshots, "desktop.png"));
  await runFile(binary, ["set", "viewport", "390", "844", "--json"], { env, timeout: 30_000 });
  assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), true);
  await evaluate("window.scrollTo(0, 0)");
  await ui("screenshot", "--out", join(screenshots, "mobile.png"));
  Object.assign(config.flags, { plans: false, invite: false, activationTelemetry: false, freeEngine: false, feedback: false });
  await evaluate("location.reload()");
  await wait('document.body.innerText.includes("Open support") && !document.body.innerText.includes("View plans") && !document.body.innerText.includes("BOS AI")');
  await click("Open support");
  assert.equal(await evaluate('document.body.innerText.includes("Tell Firaz")'), false);
  await click("Close");
  await click("Good response");
  assert.equal(await evaluate('!!document.querySelector("[role=dialog]")'), false);
  assert.equal(records.length, 4, "disabled product features must not submit");
  console.log(JSON.stringify({ ok: true, mutations: records, screenshots, logPath: fixture.info.logPath, checks: ["plans", "invite URL", "no automatic feedback", "opt-in note", "rating-only payload", "explicit useful result", "account signup target", "no legacy grant", "own-key retry", "390px layout", "feature flags off"] }, null, 2));
} finally {
  if (opened) await closeBrowserSession(opened.binary, opened.env);
  await preview?.close();
  await fixture.close();
}
