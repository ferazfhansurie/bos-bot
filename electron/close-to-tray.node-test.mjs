import assert from "node:assert/strict";
import test from "node:test";

import { closeToTrayEnabled, createCloseToTray } from "./close-to-tray.mjs";

function fakeTray() {
  const calls = [];
  const handlers = new Map();
  return {
    calls,
    handlers,
    setToolTip: (text) => calls.push(["tooltip", text]),
    setContextMenu: (menu) => calls.push(["menu", menu]),
    on: (name, handler) => handlers.set(name, handler),
    displayBalloon: (options) => calls.push(["balloon", options.title]),
    destroy: () => calls.push(["destroy"]),
  };
}

function fakeWindow({ destroyed = false } = {}) {
  const calls = [];
  return { calls, isDestroyed: () => destroyed, hide: () => calls.push("hide") };
}

function fakeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

function controller(overrides = {}) {
  const tray = fakeTray();
  const opened = [];
  const quit = [];
  const close = createCloseToTray({
    createTray: () => tray,
    buildMenu: (template) => template,
    title: "BOS Bot",
    onOpen: () => opened.push(true),
    onQuit: () => quit.push(true),
    ...overrides,
  });
  return { tray, close, opened, quit };
}

test("only Windows closes to tray, and never during smoke runs", () => {
  assert.equal(closeToTrayEnabled({ platform: "win32", env: {} }), true);
  assert.equal(closeToTrayEnabled({ platform: "win32", env: { OMB_SMOKE_TEST: "1" } }), false);
  assert.equal(closeToTrayEnabled({ platform: "darwin", env: {} }), false);
  assert.equal(closeToTrayEnabled({ platform: "linux", env: {} }), false);
});

test("closing the window hides it instead and hints once", () => {
  const { tray, close } = controller();
  const win = fakeWindow();
  const first = fakeEvent();
  assert.equal(close.handleClose(first, win), true);
  assert.equal(first.prevented, true);
  assert.deepEqual(win.calls, ["hide"]);
  close.handleClose(fakeEvent(), win);
  assert.equal(tray.calls.filter(([kind]) => kind === "balloon").length, 1);
});

test("a quit in progress lets the window really close", () => {
  const { close } = controller();
  close.markQuitting();
  const event = fakeEvent();
  const win = fakeWindow();
  assert.equal(close.handleClose(event, win), false);
  assert.equal(event.prevented, false);
  assert.deepEqual(win.calls, []);
});

test("tray menu opens and quits, click opens", () => {
  const { tray, opened, quit } = controller();
  const menu = tray.calls.find(([kind]) => kind === "menu")[1];
  assert.deepEqual(menu.map((item) => item.label ?? item.type), ["Open BOS Bot", "separator", "Quit BOS Bot"]);
  menu[0].click();
  menu[2].click();
  tray.handlers.get("click")();
  assert.equal(opened.length, 2);
  assert.equal(quit.length, 1);
});

test("without a tray the window closes normally", () => {
  const logs = [];
  const { close } = controller({ createTray: () => { throw new Error("no shell"); }, log: (line) => logs.push(line) });
  assert.equal(close.active, false);
  const event = fakeEvent();
  assert.equal(close.handleClose(event, fakeWindow()), false);
  assert.equal(event.prevented, false);
  assert.equal(logs.length, 1);
});

test("a destroyed window is left alone", () => {
  const { close } = controller();
  const event = fakeEvent();
  assert.equal(close.handleClose(event, fakeWindow({ destroyed: true })), false);
  assert.equal(event.prevented, false);
});
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
