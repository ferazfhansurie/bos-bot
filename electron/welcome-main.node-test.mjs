import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import test from 'node:test';
import { redactSecretsInLine } from './diagnostics.mjs';
import { WELCOME_PARTITION, sameWelcomeOrigin, welcomePermissionAllowed, welcomeWindowUrl } from './welcome-window.mjs';

// Exercise the committed main-process function unchanged, with Electron's
// window/session surfaces replaced by spies. No browser or live data involved.
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('function openWelcomeWindow('), main.indexOf('\nfunction ensureDesktopWorkspace('));
function fixture() {
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.url = '';
      this.webContents = new EventEmitter();
      this.webContents.getURL = () => this.url;
      this.webContents.setWindowOpenHandler = handler => { this.popup = handler; };
      this.webContents.session = {
        setPermissionCheckHandler: handler => { this.check = handler; },
        setPermissionRequestHandler: handler => { this.request = handler; },
      };
      windows.push(this);
    }
    isDestroyed() { return false; }
    show() {}
    focus() {}
    loadURL(url) { this.url = url; return Promise.resolve(); }
  }
  const context = vm.createContext({ BrowserWindow, WELCOME_PARTITION, sameWelcomeOrigin,
    welcomePermissionAllowed, welcomeWindowUrl, APP_ICON: '', welcomeWindow: null,
    shell: { openExternal: async () => {} }, externalWebUrl: url => url });
  vm.runInContext(source, context);
  return { open: context.openWelcomeWindow, windows };
}

test('remote window has no app preload and uses an isolated sandboxed partition', () => {
  const f = fixture();
  f.open('https://hi.aihlete.com/pair#code=fixture');
  const prefs = f.windows[0].options.webPreferences;
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.partition, WELCOME_PARTITION);
  assert.equal(prefs.preload, undefined);
});

test('cross-origin HTTP redirect is prevented by the window redirect guard', () => {
  const f = fixture();
  f.open('https://hi.aihlete.com/pair#code=fixture');
  let prevented = false;
  f.windows[0].webContents.emit('will-redirect', {
    url: 'https://untrusted.invalid/', isMainFrame: true,
    preventDefault() { prevented = true; },
  }, 'https://untrusted.invalid/', false, true);
  assert.equal(prevented, true, 'no will-redirect handler blocks the destination');
  let sameOriginPrevented = false;
  f.windows[0].webContents.emit('will-redirect', {
    preventDefault() { sameOriginPrevented = true; },
  }, 'https://hi.aihlete.com/room', false, true);
  assert.equal(sameOriginPrevented, false);
});

test('switching accepted welcome origins does not leave permissions pinned to the previous origin', () => {
  const f = fixture();
  f.open('https://bos.aihlete.com/pair#code=first');
  f.open('https://hi.aihlete.com/pair#code=second');
  const current = f.windows.at(-1);
  assert.equal(current.url, 'https://hi.aihlete.com/pair#code=second');
  assert.equal(current.check(current.webContents, 'notifications', 'https://hi.aihlete.com'), true,
    'the existing window retains the old origin in its permission closure');
  assert.equal(current.check(current.webContents, 'notifications', 'https://bos.aihlete.com'), false);
  let prevented = false;
  current.webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'https://hi.aihlete.com/room');
  assert.equal(prevented, false, 'same-origin navigation on the new origin stays in the window');
});

test('a second hello on the same origin reuses the window', () => {
  const f = fixture();
  f.open('https://hi.aihlete.com/pair#code=first');
  f.open('https://hi.aihlete.com/pair#code=second');
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].url, 'https://hi.aihlete.com/pair#code=second');
});

test('diagnostics masks private capability values under the renamed environment alias', () => {
  const sentinel = 'review-fixture-private-capability';
  assert.equal(redactSecretsInLine(`spawn env BOSBOT_BROWSER_CONNECTION=${sentinel} ready`).includes(sentinel), false);
});
