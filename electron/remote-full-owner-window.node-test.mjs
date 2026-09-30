import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signInRemoteOwner } from "./remote-full-owner-window.mjs";
function fixture() {
  let window, handler, removed = false, signedOut = false;
  class Window extends EventEmitter {
    constructor(options) { super(); window = this; this.options = options; this.destroyed = false;
      this.webContents = Object.assign(new EventEmitter(), { mainFrame: { url: "" }, setWindowOpenHandler: fn => { this.open = fn; }, session: { setPermissionRequestHandler: fn => { this.permission = fn; } } }); }
    async loadFile(p) { this.webContents.mainFrame.url = new URL(`file://${p}`).href; }
    isDestroyed() { return this.destroyed; }
    show() {}
    close() { this.destroyed = true; this.emit("closed"); }
  }
  const promise = signInRemoteOwner({ BrowserWindow: Window, ipcMain: { handle: (_id,h) => { handler = h; }, removeHandler: () => { removed = true; } },
    environment: { id: "fixture", origin: "https://fixture.invalid" }, createClient: () => ({ requestOTP: async () => {}, verifyOTP: async () => ({ accountToken: "secret-test-only", user: { email: "owner@example.invalid" } }), signOut: async () => { signedOut = true; } }) });
  const event = () => ({ sender: window.webContents, senderFrame: window.webContents.mainFrame });
  return { promise, window, call: (action,data) => handler(event(),action,data), forged: () => handler({ sender: {}, senderFrame: {} },"context"), removed: () => removed, signedOut: () => signedOut };
}
test("owner window is sandboxed, denies navigation/popups/permissions, and never returns its token over IPC", async () => {
  const f = fixture(); const prefs = f.window.options.webPreferences;
  assert.equal(prefs.sandbox,true); assert.equal(prefs.contextIsolation,true); assert.equal(prefs.nodeIntegration,false); assert.ok(!prefs.partition.startsWith("persist:"));
  assert.equal(f.window.open().action,"deny"); let allowed; f.window.permission(null,"media",v=>{allowed=v;}); assert.equal(allowed,false);
  let cancelled=false; f.window.webContents.emit("will-navigate", {preventDefault(){cancelled=true;}}); assert.ok(cancelled);
  await assert.rejects(f.forged()); const result = await f.call("verify",{email:"owner@example.invalid",code:"00000000"});
  assert.deepEqual(result,{verified:true}); const account = await f.promise; assert.equal(account.accountToken,"secret-test-only"); assert.ok(f.removed()); await account.close(); assert.ok(f.signedOut());
});
test("closing owner sign-in rejects and removes its narrow IPC handler", async () => { const f=fixture(); f.window.close(); await assert.rejects(f.promise,/cancelled/); assert.ok(f.removed()); });
