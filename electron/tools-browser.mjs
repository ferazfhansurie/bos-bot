// Hardening for the in-app "Browser" tool: a <webview> embedded in the main
// window's side panel. Everything here is dependency-injected (no electron
// import) so it can be exercised under plain node:test.
//
// Security model:
// - The guest runs in its own persistent partition. main.mjs injects a
//   privileged desktop-mutation header only on session.defaultSession requests
//   to the local server, so a separate partition keeps that header (and the
//   app's cookies/storage) away from arbitrary web pages.
// - Only http:, https: and about:blank may load. The app's own loopback
//   server/relay origins are refused (navigation and every subresource), so a
//   web page can never frame, navigate to, or call the BOS UI/API.
// - No preload, no Node, sandboxed, no nested webviews, no permissions.

export const TOOLS_BROWSER_PARTITION = "persist:bos-tools-browser";

/** Plain desktop Chrome user agent for the browser partitions. Electron's
 * default carries "Electron/x" and the app name, which Google sign-in and
 * Cloudflare checks treat as an embedded, untrusted browser. */
export function chromeUserAgent(platform = process.platform, chromeVersion = process.versions?.chrome ?? '') {
  const major = /^\d+/.exec(String(chromeVersion))?.[0] ?? '140';
  const os = platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : platform === 'win32' ? 'Windows NT 10.0; Win64; x64' : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || LOOPBACK_V4.test(host) ||
    host === "0.0.0.0" || host === "[::1]" || host === "[::]" ||
    /^\[::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host) || host === "[::ffff:0.0.0.0]" || host === "[::ffff:0:0]";
}

function defaultPort(protocol) {
  return protocol === "https:" || protocol === "wss:" ? "443" : protocol === "http:" || protocol === "ws:" ? "80" : "";
}

function resolveOrigins(appOrigins) {
  const list = typeof appOrigins === "function" ? appOrigins() : appOrigins;
  const parsed = [];
  for (const origin of list ?? []) {
    try {
      const url = new URL(origin);
      parsed.push({ origin: url.origin, hostname: url.hostname, port: url.port || defaultPort(url.protocol) });
    } catch {}
  }
  return parsed;
}

/** True when `url` targets one of the app's own origins. Loopback aliases
 * (localhost, 127.x, [::1], 0.0.0.0) on the same port count as the same
 * server, whatever the scheme (http/ws), so aliases cannot bypass the deny. */
export function isAppOrigin(url, { appOrigins } = {}) {
  let target;
  try {
    target = url instanceof URL ? url : new URL(url);
  } catch {
    return false;
  }
  const port = target.port || defaultPort(target.protocol);
  for (const app of resolveOrigins(appOrigins)) {
    if (target.origin === app.origin) return true;
    if (isLoopbackHost(app.hostname) && isLoopbackHost(target.hostname) && port === app.port) return true;
  }
  return false;
}

/** May the embedded browser load this top-level/frame URL? */
export function toolsBrowserUrlAllowed(url, { appOrigins } = {}) {
  if (typeof url !== "string" || url.length === 0) return false;
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol === "about:") return target.href === "about:blank";
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (!target.hostname) return false;
  return !isAppOrigin(target, { appOrigins });
}

/**
 * Mutates `will-attach-webview` arguments into the locked-down shape. Returns
 * false when the initial src is not allowed; the caller must then
 * event.preventDefault(). An empty src is treated as about:blank.
 */
export function hardenWebviewAttach(webPreferences, params, { appOrigins, partition = TOOLS_BROWSER_PARTITION, nativePopups = false } = {}) {
  delete webPreferences.preload;
  delete webPreferences.preloadURL;
  // Electron gives an explicit Session precedence over partition.
  delete webPreferences.session;
  Object.assign(webPreferences, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    javascript: true,
    plugins: false,
    disablePopups: !nativePopups,
    experimentalFeatures: false,
    webviewTag: false,
    partition,
  });
  if (params) {
    delete params.preload;
    for (const key of ["nodeintegration", "nodeintegrationinsubframes", "plugins", "disablewebsecurity", "allowpopups", "webpreferences"]) delete params[key];
    if (nativePopups) params.allowpopups = "";
    params.partition = partition;
  }
  const src = params?.src;
  if (src === undefined || src === null || src === "") return true;
  return toolsBrowserUrlAllowed(src, { appOrigins });
}

/**
 * Guards a live guest webContents (from `did-attach-webview`). Popups are
 * always denied natively; allowed ones are handed to `onPopup(url)` so the
 * renderer can open them as a new tab.
 */
let browserModifierKeys = false;
export function noteBrowserKeyInput(input = {}) { browserModifierKeys = Boolean(input.meta || input.control); }

export function attachToolsBrowserGuest(guestContents, { appOrigins, onPopup, nativePopups = false, onNativePopup, popupOptions = {} } = {}) {
  const allowed = (url) => toolsBrowserUrlAllowed(url, { appOrigins });
  let tabGestureUntil = 0;
  guestContents.on('before-input-event',(_event,input)=>{
    noteBrowserKeyInput(input);
  });
  guestContents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown' || mouse.type === 'mouseUp') {
      const modifiers=mouse.modifiers||[];
      tabGestureUntil=(mouse.button==='middle'||modifiers.includes('meta')||modifiers.includes('control')||browserModifierKeys) ? Date.now()+1000 : 0;
    }
  });
  guestContents.setWindowOpenHandler(({ url, disposition, postBody, frameName, features }) => {
    if (nativePopups && allowed(url) && !postBody && !features && (!frameName||frameName==='_blank') && (disposition==='background-tab'||(disposition==='foreground-tab'&&Date.now()<tabGestureUntil))) {
      try { onPopup?.(url, { background: disposition === 'background-tab' }); } catch {}
      return { action: "deny" };
    }
    if (nativePopups && allowed(url)) return { action: "allow", overrideBrowserWindowOptions: { width: 900, height: 720, ...popupOptions, webPreferences: { session: guestContents.session, nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false } } };
    if (allowed(url) && url !== "about:blank") {
      try {
        onPopup?.(url);
      } catch {}
    }
    return { action: "deny" };
  });
  if (nativePopups) guestContents.on("did-create-window", (child) => { attachToolsBrowserGuest(child.webContents, { appOrigins, nativePopups, onPopup, onNativePopup, popupOptions }); onNativePopup?.(child.webContents); });
  const guard = (event, url) => {
    if (!allowed(url)) event.preventDefault();
  };
  guestContents.on("will-navigate", guard);
  guestContents.on("will-redirect", guard);
  // Covers subframes too (Electron >= 25). The details object carries url.
  guestContents.on("will-frame-navigate", (details) => {
    if (!allowed(details?.url)) details.preventDefault();
  });
  // will-navigate is not emitted for programmatic loads (webview.src /
  // loadURL). Abort those after the fact; the session request filter below
  // already cancels app-origin traffic before it leaves.
  guestContents.on("did-start-navigation", (details, legacyUrl, _inPlace, legacyIsMainFrame) => {
    const url = typeof details === "object" && details && "url" in details ? details.url : legacyUrl;
    const isMainFrame = typeof details === "object" && details && "isMainFrame" in details ? details.isMainFrame : legacyIsMainFrame;
    if (!isMainFrame || allowed(url)) return;
    // Stopping and reloading synchronously inside did-start-navigation aborts
    // the main process (SIGTRAP, Electron 43). Defer to the next turn.
    setImmediate(() => {
      try {
        if (guestContents.isDestroyed?.()) return;
        guestContents.stop();
        void Promise.resolve(guestContents.loadURL("about:blank")).catch(() => {});
      } catch {}
    });
  });
  // Nested webviews are disabled by webPreferences; refuse them regardless.
  guestContents.on("will-attach-webview", (event) => event.preventDefault());
}

/** Deny every permission in the tools-browser partition and cancel any
 * request (navigation, fetch, image, websocket) aimed at the app itself.
 * Only ever called with the partition session, never defaultSession. */
export function configureToolsBrowserSession(ses, { appOrigins, requestPermission, checkPermission, shouldBlockRequest, authorizeRequest } = {}) {
  ses.setPermissionRequestHandler((contents, permission, callback, details) => { if (!requestPermission) { callback(false); return; } Promise.resolve(requestPermission(contents, permission, details)).then(allowed => callback(allowed === true), () => callback(false)); });
  ses.setPermissionCheckHandler((contents, permission, origin, details) => checkPermission?.(contents, permission, origin, details) === true);
  ses.setDevicePermissionHandler?.(() => false);
  ses.webRequest?.onBeforeRequest?.((details, callback) => {
    let cancel = isAppOrigin(details.url, { appOrigins });
    if (!cancel) { try { cancel = shouldBlockRequest?.(details) === true; } catch { /* filtering failure leaves app-origin denial intact */ } }
    if (cancel || !authorizeRequest) { callback({ cancel }); return; }
    Promise.resolve().then(() => authorizeRequest(details)).then(allowed => callback({ cancel: allowed !== true }), () => callback({ cancel: true }));
  });
}
