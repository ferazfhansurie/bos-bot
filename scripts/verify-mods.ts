// Disposable real-server + real-renderer acceptance and Chromium sandbox checks.
// BOS_MOD_TEST_CHROME must point to a test browser executable, never a user profile.
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { strict as assert } from "node:assert";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { fixtureApi, mountPreview } from "./testing/preview-fixture.ts";
const require = createRequire(import.meta.url);
const browserModule = createRequire(require.resolve("whatsapp-web.js")).resolve("puppeteer");
const puppeteer = (await import(pathToFileURL(browserModule).href)).default;
const chrome = process.env.BOS_MOD_TEST_CHROME;
if (!chrome) throw new Error("Set BOS_MOD_TEST_CHROME to an isolated test Chromium executable");
const gateDir = mkdtempSync(join(tmpdir(), "bos-mods-engine-"));
const finishGate = join(gateDir, "finish"); writeFileSync(finishGate, "ready");
const suffix = process.env.BOS_MOD_TEST_FULL_APP === "1" ? "-full-app" : "";
const controller = new AbortController();
const cancel = () => { controller.abort(); void browser?.close(); }; process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
let fixture: Awaited<ReturnType<typeof launchVerificationServer>> | undefined;
let preview: Awaited<ReturnType<typeof mountPreview>> | undefined;
let browser: any;
const evidence: Record<string, unknown> = { screenshots: [], checks: [] };
try {
  fixture = await launchVerificationServer({ ...process.env, BOS_VERIFY_STARTUP_TIMEOUT_MS: "120000", FAKE_CLAUDE_MODE: "slow", FAKE_CLAUDE_SLOW_FINISH_GATE: finishGate }, controller.signal);
  console.log(JSON.stringify({ fixture: fixture.info }));
  writeFileSync(join(fixture.info.dataDir, "app-config.json"), JSON.stringify({ version: 1, flags: { mods: true } }));
  const api = fixtureApi(fixture.info.url);
  await api("PATCH", "/api/config", { language: "en" });
  const created = await runControlOmb(["new-bot", "--name", "Pepper", "--url", fixture.info.url]) as { bot: { id: string } };
  const botId = created.bot.id;
  const enable = async (id: string, enabled: boolean) => api("POST", `/api/mods/${id}/enabled`, { enabled, revision: (await api("GET", `/api/mods/${id}`)).mod.revision });
  const bundle = { manifest: { id: "todays-leads", name: "Today's leads", version: "1.0.0", description: "A panel created through the make-mod API format", surfaces: ["panel"], permissions: ["storage"] },
    files: { "index.html": `<h2>Today's leads</h2><p id="status">No lead source connected yet.</p><p>Ask Pepper to connect your CRM and show verified leads here.</p><button id="save">Remember filter</button><script>document.querySelector('#save').onclick=async()=>{await bos.call('storage:set',{key:'filter',value:'today'});document.querySelector('#status').textContent='Filter saved: '+await bos.call('storage:get',{key:'filter'})}</script>` } };
  // Same turn-scoped bearer path used by mod_write, confined to this fixture.
  const bots = await api("GET", "/api/bots");
  const bot = bots.bots.find((item: any) => item.id === botId);
  const capResponse = await fetch(`${fixture.info.url}/api/testing/internal-capability`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId, threadId: bot.threadId, kind: "agents" }) });
  // The shared launcher does not pass OMB_TEST_INTERNAL_CAPABILITY_KEY, so this 404s and the owner PUT (identical bundle validation) runs; the turn-scoped route is unit-tested in mod-routes/agents-proxy.
  if (capResponse.ok) {
    const { token } = await capResponse.json() as { token: string };
    const response = await fetch(`${fixture.info.url}/api/internal/mods/todays-leads`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ bundle }) });
    assert.equal(response.status, 200); evidence.creation = "turn-scoped make-mod API";
  } else { await api("PUT", "/api/mods/todays-leads", { bundle, botId }); evidence.creation = "owner API, identical make-mod bundle"; }
  assert.equal((await api("GET", "/api/mods/todays-leads")).mod.enabled, false);
  await enable("todays-leads", true);
  let navigationRequests = 0;
  preview = await mountPreview(fixture, { extraRoutes: [{ path: "/__mod_leak", handler: (_req, res) => { navigationRequests++; res.end("leak reached"); } }], entry: process.env.BOS_MOD_TEST_FULL_APP === "1" ? "/scripts/testing/threads-preview.tsx" : "/scripts/testing/mods-preview.tsx", route: "/__mods.html", title: "Isolated BOS Mods", logLevel: "warn" });
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: join(fixture.info.dataDir, "mod-browser"), args: ["--disable-background-networking"] });
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(60_000);
  page.on("console", (msg: any) => { if (msg.type() === "error") console.error("browser:", msg.text().slice(0, 500)); });
  page.on("pageerror", (error: Error) => console.error("renderer:", error.message));
  await page.goto(preview.previewUrl, { waitUntil: "domcontentloaded", timeout: 300_000 });
  await page.waitForSelector('iframe[data-mod-id="todays-leads"]', { timeout: 300_000 });
  if (process.env.BOS_MOD_TEST_FULL_APP !== "1") {
    await page.evaluate(() => { Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Mods settings")?.click(); });
    await page.waitForSelector("[role=switch]"); await page.setViewport({ width: 1440, height: 1000 }); await page.screenshot({ path: "/tmp/bos-213-mods-settings.png", fullPage: true });
    (evidence.screenshots as string[]).push("/tmp/bos-213-mods-settings.png");
    await page.evaluate(() => { Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Back to conversation")?.click(); });
    await page.waitForSelector('iframe[data-mod-id="todays-leads"]');
  }
  const frameElement = await page.$('iframe[data-mod-id="todays-leads"]'); const host = await frameElement.contentFrame(); await page.waitForFunction(() => document.querySelector('iframe[data-mod-id="todays-leads"]') !== null);
  const frame = await new Promise<any>(resolve => { const check = () => host.childFrames()[0] ? resolve(host.childFrames()[0]) : setTimeout(check, 50); check(); });
  await frame.waitForSelector("#save"); await frame.click("#save"); await frame.waitForFunction(() => document.querySelector("#status")?.textContent === "Filter saved: today");
  const snap = async (name: string) => { const path = `/tmp/bos-213-mods-${name}${suffix}.png`; await page.setViewport({ width: 1440, height: 1000 }); await page.screenshot({ path, fullPage: true }); (evidence.screenshots as string[]).push(path); };
  await snap("panel-on");
  await enable("todays-leads", false);
  await page.waitForFunction(() => !document.querySelector('iframe[data-mod-id="todays-leads"]'));
  await snap("panel-off");
  await enable("todays-leads", true); await page.waitForSelector('iframe[data-mod-id="todays-leads"]'); await snap("panel-back-on");
  (evidence.checks as string[]).push("create off, render, bridge storage read/write, toggle off/on without reload");
  for (const id of ["today-at-a-glance", "standup"]) {
    const example = JSON.parse(readFileSync(new URL(`../skills/make-mod/examples/${id}.bosmod`, import.meta.url), "utf8"));
    await api("POST", "/api/mods/import", { bundle: example, botId }); await enable(id, true);
  }
  await page.waitForSelector('iframe[data-mod-id="today-at-a-glance"]');
  await page.evaluate(() => { const button = Array.from(document.querySelectorAll("button")).find(button => button.textContent === "/standup"); button?.click(); });
  await page.waitForSelector('iframe[data-mod-id="standup"]'); await snap("examples");
  const askBody = async (id: string) => ({ botId, revision: (await api("GET", "/api/mods/standup")).mod.revision, request: { id, method: "bots:ask", params: { prompt: "Draft an isolated fixture standup" } } });
  const reply = await api("POST", "/api/mods/standup/bridge", await askBody("reply-check"));
  assert.ok(typeof reply.result === "string" && reply.result.includes("Draft an isolated fixture standup"));
  rmSync(finishGate);
  const activeAsk = api("POST", "/api/mods/standup/bridge", await askBody("cancel-check")).then(value => ({ value, error: null }), error => ({ value: null, error }));
  let activeThread: string | undefined;
  for (let i = 0; i < 600; i++) {
    const current = (await api("GET", "/api/bots")).bots.find((item: any) => item.id === botId);
    activeThread = current?.tasks?.find((task: any) => task.title === "Mod request" && task.busy)?.threadId;
    if (activeThread) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(activeThread, "fake mod ask must be running before revocation");
  await enable("standup", false); const cancelled = await activeAsk; assert.ok(cancelled.error, "disabled mod ask must fail");
  for (let i = 0; i < 100; i++) {
    const current = (await api("GET", "/api/bots")).bots.find((item: any) => item.id === botId);
    if (!current?.tasks?.find((task: any) => task.threadId === activeThread)?.busy) break;
    if (i === 99) throw new Error("revoked mod turn did not stop");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  (evidence.checks as string[]).push("real fake-engine ask/reply and disable interrupts running mod conversation");
  const exported = await api("GET", "/api/mods/todays-leads/export"); assert.deepEqual(exported, bundle);
  const attack = structuredClone(bundle); attack.manifest.id = "escape-check"; attack.manifest.name = "Sandbox checks";
  attack.files["index.html"] = `<pre id="result">Checking…</pre><script>
(async()=>{const results={};try{parent.document.body;results.parentDocument=false}catch{results.parentDocument=true}try{top.location.href='https://escape.invalid';results.topNavigation=false}catch{results.topNavigation=true}try{parent.localStorage.getItem('bos-secret');results.parentStorage=false}catch{results.parentStorage=true}try{localStorage.setItem('x','y');results.ownStorage=false}catch{results.ownStorage=true}try{await fetch(${JSON.stringify(fixture.info.url + "/api/config")});results.fetch=false}catch{results.fetch=true}try{const C=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(!C)throw 0;const pc=new C({iceServers:[{urls:'stun:127.0.0.1:9'}]});pc.createDataChannel('x');results.webrtc=false}catch{results.webrtc=true}results.childWebrtc=await new Promise(resolve=>{const f=document.createElement('iframe');const done=v=>{removeEventListener('message',on);resolve(v)};const on=e=>{if(e.source===f.contentWindow&&e.data&&'childWebrtc' in e.data)done(e.data.childWebrtc)};addEventListener('message',on);f.srcdoc="<script>let blocked;try{const C=window.RTCPeerConnection||window.webkitRTCPeerConnection;if(!C)throw 0;const pc=new C({iceServers:[{urls:'stun:127.0.0.1:9'}]});pc.createDataChannel('x');blocked=false}catch{blocked=true}parent.postMessage({childWebrtc:blocked},'*')<\\/script>";document.body.appendChild(f);setTimeout(()=>done(true),3000)});try{await bos.call('threads:read',{});results.undeclared=false}catch{results.undeclared=true}document.querySelector('#result').textContent=JSON.stringify(results)})();</script>`;
  await api("PUT", "/api/mods/escape-check", { bundle: attack, botId }); await enable("escape-check", true);
  const attackElement = await page.waitForSelector('iframe[data-mod-id="escape-check"]'); const attackHost = await attackElement.contentFrame(); const attackFrame = await new Promise<any>(resolve => { const check = () => attackHost.childFrames()[0] ? resolve(attackHost.childFrames()[0]) : setTimeout(check, 50); check(); });
  await attackFrame.waitForFunction(() => document.querySelector("#result")?.textContent?.includes("undeclared"));
  const results = JSON.parse(await attackFrame.$eval("#result", (el: Element) => el.textContent));
  assert.deepEqual(results, { parentDocument: true, topNavigation: true, parentStorage: true, ownStorage: true, fetch: true, webrtc: true, childWebrtc: true, undeclared: true });
  assert.ok(page.url().includes("/__mods.html")); evidence.sandbox = results; await snap("sandbox");
  // An iframe's own navigation bypasses connect-src; the trusted outer host must block it.
  await attackFrame.evaluate((url: string) => { location.href = url; }, new URL("/__mod_leak?data=private", preview.previewUrl).href).catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 500)); assert.equal(navigationRequests, 0); evidence.selfNavigationBlocked = true;
  const denied = await fetch(`${fixture.info.url}/api/mods/escape-check/bridge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ botId, revision: (await api("GET", "/api/mods/escape-check")).mod.revision, request: { id: "unauthorized", method: "threads:read", params: {} } }) }); assert.equal(denied.status, 403);
  // Flag kill-switch must remove already-mounted frames, without restarting.
  writeFileSync(join(fixture.info.dataDir, "app-config.json"), JSON.stringify({ version: 1, flags: { mods: false } }));
  await page.waitForFunction(() => document.querySelectorAll("iframe[data-mod-id]").length === 0);
  (evidence.checks as string[]).push("examples render, export round trip, undeclared server capability denied, remote flag hot-disables all frames");
  evidence.ok = true; writeFileSync(`/tmp/bos-213-mods-evidence${suffix}.json`, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally {
  await browser?.close(); await preview?.close(); await fixture?.close(); rmSync(gateDir, { recursive: true, force: true }); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
}
