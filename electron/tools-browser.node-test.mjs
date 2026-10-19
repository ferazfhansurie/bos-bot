import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  TOOLS_BROWSER_PARTITION,
  attachToolsBrowserGuest,
  configureToolsBrowserSession,
  hardenWebviewAttach,
  toolsBrowserUrlAllowed,
  chromeUserAgent,
} from "./tools-browser.mjs";

const appOrigins = ["http://127.0.0.1:8799", "http://localhost:5173"];
const opts = { appOrigins };

function event() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

class Guest extends EventEmitter {
  loads = [];
  stopped = false;
  setWindowOpenHandler(handler) { this.open = handler; }
  stop() { this.stopped = true; }
  loadURL(url) { this.loads.push(url); return Promise.resolve(); }
}

test("partition is the dedicated persistent tools-browser partition", () => {
  assert.equal(TOOLS_BROWSER_PARTITION, "persist:bos-tools-browser");
});

test("allows only http, https and about:blank", () => {
  for (const url of ["https://example.com/", "http://example.com/a?b", "about:blank", "https://127.0.0.1:9999/"]) {
    assert.equal(toolsBrowserUrlAllowed(url, opts), true, url);
  }
  for (const url of [
    "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "chrome://settings",
    "devtools://devtools/bundled/inspector.html", "about:srcdoc", "blob:https://example.com/x",
    "ftp://example.com/", "view-source:https://example.com", "", "not a url", undefined,
  ]) {
    assert.equal(toolsBrowserUrlAllowed(url, opts), false, String(url));
  }
});

test("denies the app's own origins, including loopback aliases and ws", () => {
  for (const url of [
    "http://127.0.0.1:8799/", "http://127.0.0.1:8799/api/config", "http://localhost:8799/",
    "http://[::1]:8799/", "http://0.0.0.0:8799/", "http://127.0.0.2:8799/", "http://2130706433:8799/",
    "http://localhost:5173/", "http://127.0.0.1:5173/",
  ]) {
    assert.equal(toolsBrowserUrlAllowed(url, opts), false, url);
  }
  assert.equal(toolsBrowserUrlAllowed("http://127.0.0.1:8800/", opts), true);
  assert.equal(toolsBrowserUrlAllowed("http://127.0.0.1:8799/", { appOrigins: () => appOrigins }), false);
});

test("attach hardening strips preload and forces sandbox + partition", () => {
  const webPreferences = {
    preload: "/evil.js", preloadURL: "file:///evil.js", nodeIntegration: true, contextIsolation: false,
    sandbox: false, webSecurity: false, allowRunningInsecureContent: true, plugins: true,
    experimentalFeatures: true, webviewTag: true, nodeIntegrationInSubFrames: true, partition: "persist:other",
  };
  const params = { src: "https://example.com/", partition: "", preload: "file:///evil.js", nodeintegration: "on", allowpopups: "on" };
  assert.equal(hardenWebviewAttach(webPreferences, params, opts), true);
  assert.equal("preload" in webPreferences, false);
  assert.equal("preloadURL" in webPreferences, false);
  assert.equal("preload" in params, false);
  assert.equal("nodeintegration" in params, false);
  assert.equal("allowpopups" in params, false);
  assert.equal(params.partition, TOOLS_BROWSER_PARTITION);
  assert.equal(webPreferences.partition, TOOLS_BROWSER_PARTITION);
  assert.deepEqual(
    {
      nodeIntegration: webPreferences.nodeIntegration, nodeIntegrationInSubFrames: webPreferences.nodeIntegrationInSubFrames,
      contextIsolation: webPreferences.contextIsolation, sandbox: webPreferences.sandbox, webSecurity: webPreferences.webSecurity,
      allowRunningInsecureContent: webPreferences.allowRunningInsecureContent, javascript: webPreferences.javascript,
      plugins: webPreferences.plugins, experimentalFeatures: webPreferences.experimentalFeatures, webviewTag: webPreferences.webviewTag,
    },
    {
      nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, javascript: true, plugins: false, experimentalFeatures: false, webviewTag: false,
    },
  );
});

test("attach is refused for disallowed src, allowed for blank", () => {
  assert.equal(hardenWebviewAttach({}, { src: "file:///etc/passwd" }, opts), false);
  assert.equal(hardenWebviewAttach({}, { src: "http://127.0.0.1:8799/" }, opts), false);
  assert.equal(hardenWebviewAttach({}, { src: "javascript:alert(1)" }, opts), false);
  assert.equal(hardenWebviewAttach({}, { src: "" }, opts), true);
  assert.equal(hardenWebviewAttach({}, { src: "about:blank" }, opts), true);
});

test("popups are always denied and allowed ones forwarded", () => {
  const guest = new Guest();
  const popups = [];
  attachToolsBrowserGuest(guest, { appOrigins, onPopup: (url) => popups.push(url) });
  assert.deepEqual(guest.open({ url: "https://example.com/new" }), { action: "deny" });
  assert.deepEqual(guest.open({ url: "file:///etc/passwd" }), { action: "deny" });
  assert.deepEqual(guest.open({ url: "http://localhost:8799/" }), { action: "deny" });
  assert.deepEqual(guest.open({ url: "about:blank" }), { action: "deny" });
  assert.deepEqual(popups, ["https://example.com/new"]);
});

test("a throwing popup handler still denies", () => {
  const guest = new Guest();
  attachToolsBrowserGuest(guest, { appOrigins, onPopup: () => { throw new Error("boom"); } });
  assert.deepEqual(guest.open({ url: "https://example.com/" }), { action: "deny" });
});

test("navigation and redirects to file: or the app origin are prevented", () => {
  const guest = new Guest();
  attachToolsBrowserGuest(guest, { appOrigins });
  for (const name of ["will-navigate", "will-redirect"]) {
    for (const url of ["file:///etc/passwd", "http://127.0.0.1:8799/", "chrome://gpu"]) {
      const e = event();
      guest.emit(name, e, url);
      assert.equal(e.prevented, true, `${name} ${url}`);
    }
    const ok = event();
    guest.emit(name, ok, "https://example.com/");
    assert.equal(ok.prevented, false);
  }
  const frame = { url: "http://localhost:8799/", ...event() };
  guest.emit("will-frame-navigate", frame);
  assert.equal(frame.prevented, true);
  const okFrame = { url: "https://example.com/", ...event() };
  guest.emit("will-frame-navigate", okFrame);
  assert.equal(okFrame.prevented, false);
  const nested = event();
  guest.emit("will-attach-webview", nested, {}, {});
  assert.equal(nested.prevented, true);
});

test("programmatic main-frame loads of disallowed URLs are aborted after the event", async () => {
  const guest = new Guest();
  attachToolsBrowserGuest(guest, { appOrigins });
  guest.emit("did-start-navigation", { url: "https://example.com/", isMainFrame: true });
  guest.emit("did-start-navigation", { url: "file:///etc/passwd", isMainFrame: true });
  assert.equal(guest.stopped, false, "never stopped inside did-start-navigation");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guest.stopped, true);
  assert.deepEqual(guest.loads, ["about:blank"]);
  const gone = new Guest();
  gone.isDestroyed = () => true;
  attachToolsBrowserGuest(gone, { appOrigins });
  gone.emit("did-start-navigation", { url: "http://127.0.0.1:8799/", isMainFrame: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gone.stopped, false);
});

test("session denies every permission and cancels app-origin requests", () => {
  const ses = { webRequest: {} };
  ses.setPermissionRequestHandler = (h) => { ses.request = h; };
  ses.setPermissionCheckHandler = (h) => { ses.check = h; };
  ses.webRequest.onBeforeRequest = (h) => { ses.before = h; };
  configureToolsBrowserSession(ses, { appOrigins });
  let granted;
  ses.request({}, "media", (value) => { granted = value; });
  assert.equal(granted, false);
  assert.equal(ses.check({}, "notifications", "https://example.com"), false);
  let result;
  ses.before({ url: "http://127.0.0.1:8799/api/config" }, (r) => { result = r; });
  assert.deepEqual(result, { cancel: true });
  ses.before({ url: "ws://localhost:8799/ws" }, (r) => { result = r; });
  assert.deepEqual(result, { cancel: true });
  ses.before({ url: "https://example.com/" }, (r) => { result = r; });
  assert.deepEqual(result, { cancel: false });
});

test("the tools browser presents a plain chrome user agent", () => {
  assert.equal(chromeUserAgent("darwin", "140.0.7339.80"), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36");
  assert.match(chromeUserAgent("win32", "141.1"), /Windows NT 10\.0; Win64; x64.*Chrome\/141\.0\.0\.0 Safari/);
  assert.doesNotMatch(chromeUserAgent(), /Electron|bos/i);
});
