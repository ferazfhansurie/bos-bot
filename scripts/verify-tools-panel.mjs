// Real ToolsPanel in disposable Electron windows: a 1.6 shell (production
// preload, webviewTag, tools-browser hardening) and a pre-1.6 shell (no
// webviewTag, an older preload without the tools-browser partition).
// Run: node scripts/verify-tools-panel.mjs [old-preload.cjs] [--base <rev>]
// --base bundles ToolsPanel.tsx from <rev> instead of the working tree.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureFlag = "--omb-tools-panel-fixture";

if (process.versions.electron && process.argv.includes(fixtureFlag)) {
  const { app, BrowserWindow, session, webContents } = await import("electron");
  const { TOOLS_BROWSER_PARTITION, attachToolsBrowserGuest, configureToolsBrowserSession, hardenWebviewAttach } = await import("../electron/tools-browser.mjs");
  const [url, pageUrl, output, oldPreload, expectFix, only] = process.argv.slice(process.argv.indexOf(fixtureFlag) + 1);
  const fixed = expectFix === "fix";
  app.setPath("userData", join(output, "user-data"));
  app.setPath("sessionData", join(output, "user-data"));
  app.commandLine.appendSwitch("disable-background-networking");
  app.dock?.hide();
  const appOrigins = () => [new URL(url).origin];
  let modern = null;
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event, webPreferences, params) => {
      if (contents !== modern?.webContents || !hardenWebviewAttach(webPreferences, params, { appOrigins })) event.preventDefault();
    });
    contents.on("did-attach-webview", (_attach, guest) => attachToolsBrowserGuest(guest, { appOrigins }));
  });
  const results = {};
  app.whenReady().then(async () => {
    configureToolsBrowserSession(session.fromPartition(TOOLS_BROWSER_PARTITION), { appOrigins });
    const run = async (shell) => {
      const win = new BrowserWindow({
        show: false, width: 900, height: 700,
        webPreferences: {
          preload: shell === "1.6" ? join(root, "electron/preload.cjs") : oldPreload,
          contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
          webviewTag: shell === "1.6",
          additionalArguments: [`--omb-local-origin=${new URL(url).origin}`],
        },
      });
      if (shell === "1.6") modern = win;
      win.webContents.on("console-message", (event) => { if (event.level === "error") console.error(`[${shell}]`, event.message); });
      win.webContents.on("did-fail-load", (_e, code, desc, failed, main) => console.error(`[${shell}] did-fail-load`, code, desc, failed, main));
      await win.loadURL(url);
      const evaluate = (code) => win.webContents.executeJavaScript(code);
      const shot = async (name) => writeFileSync(join(output, `${expectFix}-${shell}-${name}.png`), (await win.webContents.capturePage()).toPNG());
      const until = async (check, description, attempts = 200) => {
        for (let i = 0; i < attempts; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 30)); }
        if (description) { await shot("failure"); throw new Error(`[${shell}] timed out: ${description}`); }
        return false;
      };
      const guest = () => webContents.getAllWebContents().find((c) => c.getType() === "webview" && c.hostWebContents === win.webContents);
      const go = (address) => evaluate(`(() => { const el = document.querySelector('input[aria-label="Search or enter a URL"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(address)});
        el.dispatchEvent(new Event('input', { bubbles: true })); el.form.requestSubmit(); })()`);
      await until(() => evaluate("Boolean(document.querySelector('[data-testid=tools-panel] [data-tool]'))"), "tools home rendered");
      const tiles = await evaluate("[...document.querySelectorAll('[data-tool]')].map(el => el.textContent.trim())");
      await shot("home");
      await evaluate("document.querySelector('[data-tool=browser]').click()");
      const result = { tiles, bridgePartition: await evaluate("window.ogb?.toolsBrowserPartition ?? null") };
      if (fixed && shell !== "1.6") {
        await until(() => evaluate("Boolean(document.querySelector('[data-testid=tools-panel] [role=status]'))"), "unsupported-shell notice");
        result.notice = await evaluate("document.querySelector('[data-testid=tools-panel] [role=status]').innerText");
        result.webviewElements = await evaluate("document.querySelectorAll('webview').length");
        await shot("browser");
        return result;
      }
      await until(() => evaluate("Boolean(document.querySelector('input[aria-label=\"Search or enter a URL\"]'))"), "browser address bar");
      await go(pageUrl);
      result.loaded = await until(() => guest()?.getURL() === pageUrl && guest()?.getTitle() === "Fixture page", null, 160);
      result.guestUrl = guest()?.getURL() ?? null;
      result.webviewElements = await evaluate("document.querySelectorAll('webview').length");
      result.tabTitles = await evaluate("[...document.querySelectorAll('button.truncate')].map(b => b.textContent.trim())");
      await shot("browser");
      console.error(`[${shell}] loaded`, JSON.stringify(result));
      if (result.loaded && !process.env.SKIP_APP_ORIGIN) {
        await go(new URL(url).origin + "/");
        await new Promise((r) => setTimeout(r, 1200));
        result.appOriginBlockedUrl = guest()?.getURL() ?? null;
      }
      return result;
    };
    try {
      results[only] = await run(only);
      writeFileSync(join(output, `${expectFix}-${only}-results.json`), JSON.stringify(results[only], null, 2));
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  });
} else {
  const args = process.argv.slice(2);
  const baseAt = args.indexOf("--base");
  const base = baseAt >= 0 ? args.splice(baseAt, 2)[1] : null;
  const oldPreload = args[0];
  assert.ok(oldPreload, "pass the pre-1.6 preload.cjs (e.g. extracted from an installed app.asar)");
  const output = process.env.OMB_FIXTURE_OUTPUT ?? mkdtempSync(join(tmpdir(), "omb-tools-panel-"));
  mkdirSync(output, { recursive: true });
  const userData = join(output, "user-data");
  const { build } = await import("esbuild");
  const panel = base ? execFileSync("git", ["show", `${base}:src/components/ToolsPanel.tsx`], { cwd: root, encoding: "utf8" }) : null;
  const bundle = await build({
    stdin: {
      contents: `import { createRoot } from "react-dom/client"; import { createElement } from "react";
        import { ToolsPanel } from "fixture-panel";
        createRoot(document.getElementById("root")).render(
          createElement("div", { style: { display: "flex", height: "100vh" } }, createElement(ToolsPanel, { target: { botId: "fixture-bot", threadId: "fixture-thread" }, onClose() {} })));`,
      resolveDir: root, loader: "tsx",
    },
    bundle: true, write: false, format: "esm", jsx: "automatic", alias: { "@": join(root, "src") },
    loader: { ".css": "empty", ".svg": "dataurl", ".png": "dataurl", ".woff2": "dataurl" },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
    logLevel: "error",
    plugins: [{ name: "fixture-panel", setup(b) {
      b.onResolve({ filter: /^fixture-panel$/ }, () => panel ? { path: "ToolsPanel.base.tsx", namespace: "base" } : { path: join(root, "src/components/ToolsPanel.tsx") });
      b.onLoad({ filter: /.*/, namespace: "base" }, () => ({ contents: panel, loader: "tsx", resolveDir: join(root, "src/components") }));
    } }],
  });
  const js = bundle.outputFiles[0].contents;
  const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#070707;color:#eee;font-family:system-ui"><div id="root"></div><script type="module" src="/bundle.js"></script>';
  const listen = (handler) => new Promise((resolve) => { const s = createServer(handler).listen(0, "127.0.0.1", () => resolve(s)); });
  const ui = await listen((req, res) => {
    if (req.url === "/bundle.js") { res.writeHead(200, { "content-type": "text/javascript" }); res.end(js); return; }
    if (req.url?.startsWith("/api/")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
    res.writeHead(200, { "content-type": "text/html" }); res.end(html);
  });
  const page = await listen((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>Fixture page</title><h1>fixture guest page</h1>"); });
  const url = `http://127.0.0.1:${ui.address().port}/`;
  const pageUrl = `http://127.0.0.1:${page.address().port}/`;
  const electron = join(root, "node_modules/.bin/electron");
  // A host app may export ELECTRON_RUN_AS_NODE; the fixture needs a real Electron app.
  const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env;
  const variant = base ? "base" : "fix";
  // One Electron process per shell, so the two windows never share a session.
  const results = {};
  for (const shell of ["1.3", "1.6"]) {
    const child = spawn(electron, [fileURLToPath(import.meta.url), fixtureFlag, url, pageUrl, output, oldPreload, variant, shell], {
      stdio: ["ignore", "inherit", "inherit"], env,
    });
    const code = await new Promise((resolve) => child.on("exit", resolve));
    rmSync(userData, { recursive: true, force: true });
    assert.equal(code, 0, `fixture electron (${shell} shell) exited cleanly`);
    results[shell] = JSON.parse(readFileSync(join(output, `${variant}-${shell}-results.json`), "utf8"));
  }
  ui.close(); page.close();
  console.log(JSON.stringify(results, null, 2));
  if (base) {
    // Reproduction: the base panel in a pre-1.6 shell renders an inert <webview>.
    assert.equal(results["1.3"].bridgePartition, null);
    assert.equal(results["1.3"].webviewElements, 1);
    assert.equal(results["1.3"].loaded, false);
    assert.equal(results["1.3"].guestUrl, null);
  } else {
    for (const shell of ["1.3", "1.6"]) assert.deepEqual(results[shell].tiles, ["Terminal", "Browser"]);
    assert.equal(results["1.3"].webviewElements, 0);
    assert.match(results["1.3"].notice, /too old for the browser/);
    assert.equal(results["1.6"].loaded, true);
    assert.equal(results["1.6"].guestUrl, pageUrl);
    assert.notEqual(new URL(results["1.6"].appOriginBlockedUrl ?? "about:blank").origin, new URL(url).origin);
  }
  console.log(`tools panel fixture passed (${base ? `base ${base}` : "working tree"}); evidence in ${output}`);
}
