// Offline Chromium fixture. Tests delayed authorization and the ordinary
// Continue link without contacting an OAuth provider or a real account.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { transform } from "esbuild";

// Use the browser test dependency already shipped with our WhatsApp adapter.
const require = createRequire(import.meta.url);
const puppeteer = createRequire(require.resolve("whatsapp-web.js"))("puppeteer");
const { code } = await transform(readFileSync(new URL("../src/lib/connection-window.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
const server = createServer((req, res) => {
  if (req.url === "/helper.js") { res.setHeader("content-type", "text/javascript"); return res.end(code); }
  if (req.url === "/oauth") return res.end("offline oauth destination");
  res.setHeader("content-type", "text/html");
  res.end(`<button>connect</button><a target="_blank" rel="noopener noreferrer">continue</a><script type="module">import {reserveConnectionWindow} from '/helper.js';document.querySelector('button').onclick=async()=>{const reserved=reserveConnectionWindow();await new Promise(r=>setTimeout(r,200));const url=location.origin+'/oauth';document.querySelector('a').href=url;window.opened=await reserved.navigate(url);};</script>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(origin);
  const firstPopup = new Promise(resolve => page.once("popup", resolve));
  await page.click("button");
  const popup = await firstPopup;
  await popup.waitForFunction(() => location.pathname === "/oauth");
  assert.equal(await popup.evaluate(() => window.opener === null), true);
  await popup.close();
  await page.goto(origin);
  await page.evaluate(() => { window.attempts = 0; window.open = () => { window.attempts++; return null; }; });
  await page.click("button");
  await page.waitForFunction(() => window.opened === false);
  assert.equal(await page.evaluate(() => window.attempts), 1, "blocked reservation is not retried asynchronously");
  assert.equal(await page.$eval("a", link => link.rel), "noopener noreferrer");
  // The ordinary anchor uses the browser, rather than the broken window.open
  // hook. Electron's external-link handler receives this final URL directly.
  const continued = new Promise(resolve => page.once("popup", resolve));
  await page.click("a");
  const destination = await continued;
  await destination.waitForFunction(() => location.pathname === "/oauth");
  assert.equal(await destination.evaluate(() => window.opener === null), true);
  assert.equal(destination.url(), `${origin}/oauth`);
  console.log("connector popup fixture passed: delayed navigation, opener null, blocked reservation and direct Continue link");
} finally { await browser?.close(); server.close(); }
