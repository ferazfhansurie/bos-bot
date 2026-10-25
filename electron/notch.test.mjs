import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, ipcMain: {}, screen: {} }));

import { chooseNotchDisplay, parseNotchAction, parseNotchDrop, pickNotchScreen, snapshotIdle } from "./notch.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notch-test-"));
const file = path.join(dir, "brief.pdf");
fs.writeFileSync(file, "hello");
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("parseNotchAction", () => {
  it("keeps a well-formed open", () => {
    expect(parseNotchAction({ type: "open", botId: "b1", threadId: "t-1" })).toEqual({ type: "open", botId: "b1", threadId: "t-1" });
  });

  it("drops ids that are not ids", () => {
    expect(parseNotchAction({ type: "open", botId: "../etc", threadId: "t" })).toBeNull();
    expect(parseNotchAction({ type: "open", botId: 4 })).toBeNull();
    expect(parseNotchAction(null)).toBeNull();
    expect(parseNotchAction({ type: "run", cmd: "rm" })).toBeNull();
  });

  it("takes exactly one kind of answer", () => {
    expect(parseNotchAction({ type: "answer", askId: "a", answer: { behavior: "allow" } })).toEqual({ type: "answer", askId: "a", answer: { behavior: "allow" } });
    expect(parseNotchAction({ type: "answer", askId: "a", answer: { option: "yes" } })?.answer).toEqual({ option: "yes" });
    expect(parseNotchAction({ type: "answer", askId: "a", answer: { text: "  " } })).toBeNull();
    expect(parseNotchAction({ type: "answer", askId: "a", answer: { behavior: "always" } })).toBeNull();
    expect(parseNotchAction({ type: "answer", askId: "", answer: { behavior: "deny" } })).toBeNull();
  });

  it("trims long answers", () => {
    const action = parseNotchAction({ type: "answer", askId: "a", answer: { text: "x".repeat(50_000) } });
    expect(action.answer.text).toHaveLength(20_000);
  });

  it("keeps only real files from a drop, with their real size", () => {
    const action = parseNotchDrop({
      botId: "b1",
      threadId: "t1",
      files: [
        { name: "brief.pdf", path: file, size: 999 },
        { name: "dir", path: dir, size: 0 },
        { name: "rel", path: "brief.pdf", size: 1 },
        { name: "gone", path: path.join(dir, "missing"), size: 1 },
      ],
    });
    expect(action).toEqual({ type: "drop", botId: "b1", threadId: "t1", files: [{ name: "brief.pdf", path: file, size: 5 }] });
    expect(parseNotchDrop({ botId: "b1", threadId: "t1", files: [{ path: dir }] })).toBeNull();
    expect(parseNotchDrop({ botId: "b1", files: [{ path: file }] })).toBeNull();
  });

  it("keeps a quick ask with words, and only with words", () => {
    expect(parseNotchAction({ type: "ask", botId: "b1", threadId: "t1", text: "  what's left on acme?  " }))
      .toEqual({ type: "ask", botId: "b1", threadId: "t1", text: "what's left on acme?" });
    expect(parseNotchAction({ type: "ask", botId: "b1", threadId: "t1", text: "   " })).toBeNull();
    expect(parseNotchAction({ type: "ask", botId: "b1", threadId: "", text: "hi" })).toBeNull();
    expect(parseNotchAction({ type: "ask", botId: "../x", threadId: "t1", text: "hi" })).toBeNull();
  });

  it("never takes a drop through the action channel", () => {
    expect(parseNotchAction({ type: "drop", botId: "b1", threadId: "t1", files: [{ name: "brief.pdf", path: file }] })).toBeNull();
  });
});

describe("pickNotchScreen", () => {
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 33, width: 1470, height: 923 } };

  it("uses the camera housing on a notched screen", () => {
    const pick = pickNotchScreen([{ id: 1, notch: { x: 646, width: 179, height: 32 }, menuBar: 33 }], primary);
    expect(pick).toMatchObject({ mode: "notch", notch: { width: 179, height: 32 }, menuBar: 33 });
    expect(pick.centre).toBeCloseTo(735.5);
  });

  it("falls back to a menu-bar-tall pill elsewhere", () => {
    const external = { id: 2, bounds: { x: 1470, y: -200, width: 2560, height: 1440 }, workArea: { x: 1470, y: -175, width: 2560, height: 1415 } };
    const pick = pickNotchScreen([{ id: 1, notch: { x: 646, width: 179, height: 32 } }], external);
    expect(pick).toMatchObject({ mode: "pill", notch: { width: 0, height: 25 }, menuBar: 25 });
    expect(pick.centre).toBe(1470 + 1280);
  });

  it("never draws a sliver when the menu bar hides itself", () => {
    const hidden = { ...primary, workArea: { ...primary.workArea, y: 0 } };
    expect(pickNotchScreen([], hidden).notch.height).toBe(24);
  });
});

describe("chooseNotchDisplay", () => {
  const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1470, height: 956 } };
  const external = { id: 2, bounds: { x: 1470, y: -200, width: 2560, height: 1440 } };
  const displays = [laptop, external];
  const onExternal = { x: 2000, y: 300 };

  it("wakes on the screen under the pointer", () => {
    expect(chooseNotchDisplay({ displays, primary: laptop, cursor: onExternal, current: 1, idle: false, waking: true, notched: [1] })).toBe(external);
  });

  it("stays put while it shows something", () => {
    expect(chooseNotchDisplay({ displays, primary: laptop, cursor: onExternal, current: 1, idle: false, notched: [1] })).toBe(laptop);
  });

  it("goes home to the camera housing when quiet", () => {
    expect(chooseNotchDisplay({ displays, primary: external, cursor: onExternal, current: 2, idle: true, notched: [1] })).toBe(laptop);
  });

  it("follows the pointer when no screen has a housing, and survives a lost display", () => {
    expect(chooseNotchDisplay({ displays, primary: laptop, cursor: onExternal, current: null, idle: true })).toBe(external);
    expect(chooseNotchDisplay({ displays: [laptop], primary: laptop, cursor: onExternal, current: 2, idle: false })).toBe(laptop);
  });
});

describe("snapshotIdle", () => {
  it("is quiet only with nothing working, waiting or just done", () => {
    expect(snapshotIdle(null)).toBe(true);
    expect(snapshotIdle({ working: [], asks: [], moments: [] })).toBe(true);
    expect(snapshotIdle({ working: [{}], asks: [], moments: [] })).toBe(false);
    expect(snapshotIdle({ working: [], asks: [], moments: [{}] })).toBe(false);
  });
});

describe("pickNotchScreen full screen", () => {
  it("passes on an app full screen on that display", () => {
    const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1470, height: 956 }, workArea: { x: 0, y: 33, width: 1470, height: 923 } };
    expect(pickNotchScreen([{ id: 1, notch: { x: 646, width: 179, height: 32 }, menuBar: 33, fullscreen: true }], laptop).fullscreen).toBe(true);
    expect(pickNotchScreen([{ id: 1, menuBar: 25 }], laptop).fullscreen).toBe(false);
  });
});
