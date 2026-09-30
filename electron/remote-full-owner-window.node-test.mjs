import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmRemoteFull } from "./remote-full-client.mjs";
import { signInRemoteOwner } from "./remote-full-owner-window.mjs";

const account = { accountToken: "secret-test-only", user: { email: "owner@example.invalid" } };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ requestOTP = async () => {}, verifyOTP = async () => account, signOut = async () => {} } = {}) {
  let window, handler, timer;
  const counts = { removed: 0, cleared: 0, signedOut: 0, closed: 0, shown: 0 };
  const frame = { url: "" };
  const contents = Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed; },

    setWindowOpenHandler(fn) { this.open = fn; },
    session: { setPermissionRequestHandler(fn) { contents.permission = fn; } },
  });
  Object.defineProperty(contents, "mainFrame", { get() { if (contents.destroyed) throw new Error("destroyed frame accessed"); return frame; } });
  class Window extends EventEmitter {
    constructor(options) { super(); window = this; this.options = options; this.destroyed = false; }
    get webContents() { if (this.destroyed) throw new Error("destroyed window accessed"); return contents; }
    async loadFile(p) { frame.url = new URL(`file://${p}`).href; }
    isDestroyed() { return this.destroyed; }
    show() { assert.equal(this.destroyed, false); counts.shown++; }
    close() { assert.equal(this.destroyed, false, "must not close twice"); counts.closed++; this.emit("close"); this.destroy(); }
    destroy() { this.destroyed = true; contents.destroyed = true; contents.emit("destroyed"); this.emit("closed"); }
  }
  const promise = signInRemoteOwner({ BrowserWindow: Window,
    ipcMain: { handle: (_id, h) => { handler = h; }, removeHandler: () => { counts.removed++; } },
    timers: { setTimeout: (callback, milliseconds) => { assert.equal(milliseconds, 600_000); timer = callback; return 42; }, clearTimeout: id => { assert.equal(id, 42); counts.cleared++; } },
    environment: { id: "bookmark", environmentId: "fixture", origin: "https://fixture.invalid" },
    createClient: () => ({ requestOTP, verifyOTP, signOut: async token => { assert.equal(token, account.accountToken); counts.signedOut++; await signOut(token); } }),
  });
  // Observe cancellation immediately, even when the outstanding IPC resolves later.
  const outcome = promise.then(() => "resolved", error => { assert.match(error.message, /cancelled/); return "rejected"; });
  const event = { sender: contents, senderFrame: frame };
  return { promise, outcome, counts, window, contents, tick: () => timer(),
    call: (action, data) => handler(event, action, data), forged: () => handler({ sender: {}, senderFrame: {} }, "context") };
}
const verifyInput = { email: "owner@example.invalid", code: "00000000" };
function assertCleaned(f) {
  assert.equal(f.counts.removed, 1);
  assert.equal(f.counts.cleared, 1);
  assert.equal(f.window.listenerCount("close"), 0);
  assert.equal(f.window.listenerCount("closed"), 0);
  assert.equal(f.window.listenerCount("ready-to-show"), 0);
  assert.equal(f.contents.listenerCount("destroyed"), 0);
}

test("owner window is sandboxed, denies navigation/popups/permissions, and never returns its token over IPC", async () => {
  const f = fixture(); const prefs = f.window.options.webPreferences;
  assert.equal(prefs.sandbox, true); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.nodeIntegration, false); assert.ok(!prefs.partition.startsWith("persist:"));
  assert.equal(f.contents.open().action, "deny"); let allowed; f.contents.permission(null, "media", v => { allowed = v; }); assert.equal(allowed, false);
  let cancelled = false; f.contents.emit("will-navigate", { preventDefault() { cancelled = true; } }); assert.ok(cancelled);
  await assert.rejects(f.forged());
  assert.deepEqual(await f.call("verify", verifyInput), { verified: true });
  const signedIn = await f.promise;
  assert.equal(signedIn.accountToken, account.accountToken); assertCleaned(f);
  await Promise.all([signedIn.close(), signedIn.close()]);
  f.tick(); f.window.emit("closed");
  assert.equal(f.counts.signedOut, 1); assert.equal(f.counts.closed, 1); assertCleaned(f);
});

test("closing owner sign-in rejects and removes its narrow IPC handler", async () => {
  const f = fixture(); f.window.close(); assert.equal(await f.outcome, "rejected"); assertCleaned(f);
  await assert.rejects(f.call("verify", verifyInput), /Owner window only/);
  f.tick(); f.window.emit("ready-to-show"); assert.equal(f.counts.shown, 0); assertCleaned(f);
});

for (const action of ["request", "verify"]) {
  for (const cancellation of ["close", "timeout", "destroy", "contents-destroyed"]) {
    for (const completion of ["success", "network-error"]) {
      test(`${cancellation} during ${action} suppresses late ${completion} and cleans up exactly once`, async () => {
        const network = deferred();
        const f = fixture(action === "verify" ? { verifyOTP: () => network.promise } : { requestOTP: () => network.promise });
        const ipc = f.call(action, verifyInput);
        if (cancellation === "close") f.window.close();
        if (cancellation === "timeout") f.tick();
        if (cancellation === "destroy") f.window.destroy();
        if (cancellation === "contents-destroyed") { f.contents.destroyed = true; f.contents.emit("destroyed"); }
        assert.equal(await f.outcome, "rejected");
        assertCleaned(f);
        const closes = f.counts.closed;
        if (completion === "success") network.resolve(action === "verify" ? account : { email: verifyInput.email });
        else network.reject(new Error("synthetic late network failure"));
        const result = await ipc;
        assert.deepEqual(result, { cancelled: true });
        assert.ok(!JSON.stringify(result).includes(account.accountToken));
        assert.equal(f.counts.signedOut, action === "verify" && completion === "success" ? 1 : 0);
        // A queued timer/event or late completion must never touch destroyed UI.
        f.tick(); f.window.emit("closed"); f.window.emit("ready-to-show"); f.contents.emit("destroyed");
        assert.equal(f.counts.closed, closes); assert.equal(f.counts.shown, 0); assertCleaned(f);
      });
    }
  }
}

test("late-session revocation failure stays cancelled, makes one attempt and exposes no token", async () => {
  const network = deferred();
  const f = fixture({ verifyOTP: () => network.promise, signOut: async () => { throw new Error("offline"); } });
  const ipc = f.call("verify", verifyInput); f.tick();
  assert.equal(await f.outcome, "rejected"); network.resolve(account);
  assert.deepEqual(await ipc, { cancelled: true }); assert.equal(f.counts.signedOut, 1); assertCleaned(f);
});

test("a live network failure permits retry, while concurrent requests remain blocked", async () => {
  const network = deferred(); let attempts = 0;
  const f = fixture({ verifyOTP: () => ++attempts === 1 ? network.promise : Promise.resolve(account) });
  const ipc = f.call("verify", verifyInput);
  assert.deepEqual(await f.call("verify", verifyInput), { error: "A request is already in progress" });
  network.reject(new Error("offline"));
  assert.deepEqual(await ipc, { error: "Sign-in failed. Check the code or try again." });
  assert.deepEqual(await f.call("verify", verifyInput), { verified: true });
  const signedIn = await f.promise; await signedIn.close();
  assert.equal(attempts, 2); assert.equal(f.counts.signedOut, 1); assertCleaned(f);
});


test("close intent cancels before destruction even if verification wins the network race", async () => {
  const network = deferred(); const f = fixture({ verifyOTP: () => network.promise });
  const ipc = f.call("verify", verifyInput);
  f.window.emit("close"); // Native close initiated, but Chromium has not died yet.
  assert.equal(await f.outcome, "rejected"); assert.equal(f.window.isDestroyed(), false);
  network.resolve(account); assert.deepEqual(await ipc, { cancelled: true });
  assert.equal(f.counts.signedOut, 1); assert.equal(f.counts.closed, 0); assertCleaned(f);
  f.window.destroy();
});

test("cancelled deferred owner verification cannot reach the native grant controller", async () => {
  const network = deferred(); const f = fixture({ verifyOTP: () => network.promise }); let grants = 0;
  const forbidden = async () => { grants++; throw new Error("grant must not be reached"); };
  const grant = confirmRemoteFull({ environment: { id: "bookmark", environmentId: "fixture", origin: "https://fixture.invalid" },
    targets: [{ botId: "sol", threadId: "selected", updateBotDefault: true }], stillCurrent: () => true,
    ownerSignIn: () => f.promise, request: forbidden, authorize: forbidden, confirm: forbidden, pinEnvironment: forbidden });
  const rejected = assert.rejects(grant, /cancelled/);
  const ipc = f.call("verify", verifyInput); f.tick(); await rejected;
  network.resolve(account); assert.deepEqual(await ipc, { cancelled: true });
  assert.equal(grants, 0); assert.equal(f.counts.signedOut, 1); assertCleaned(f);
});
