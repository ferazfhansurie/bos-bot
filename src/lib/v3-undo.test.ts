import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetUndo, dismissUndo, showUndo, undoNow } from "./v3-undo";
import { V3_WORDS } from "./v3-words";
import en from "@/locales/en.json";

afterEach(() => {
  __resetUndo();
  vi.useRealTimers();
});

describe("v3 undo toast", () => {
  it("undo puts it back and never commits", () => {
    const undo = vi.fn();
    const commit = vi.fn();
    const id = showUndo("deleted", { undo, commit });
    undoNow(id);
    expect(undo).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });

  it("running out commits the deferred part once", () => {
    vi.useFakeTimers();
    const commit = vi.fn();
    showUndo("deleted", { commit }, 100);
    vi.advanceTimersByTime(150);
    expect(commit).toHaveBeenCalledOnce();
  });

  it("a new toast lets the previous one finish", () => {
    const first = vi.fn();
    const firstUndo = vi.fn();
    showUndo("one", { commit: first, undo: firstUndo });
    showUndo("two");
    expect(first).toHaveBeenCalledOnce();
    expect(firstUndo).not.toHaveBeenCalled();
  });

  it("dismiss commits; a stale id does nothing", () => {
    const commit = vi.fn();
    const undo = vi.fn();
    const id = showUndo("x", { commit, undo });
    undoNow(id + 99);
    dismissUndo(id);
    undoNow(id);
    expect(commit).toHaveBeenCalledOnce();
    expect(undo).not.toHaveBeenCalled();
  });
});

describe("v3 plain words", () => {
  it("only rewords keys the catalog has and keeps their placeholders", () => {
    for (const [key, text] of Object.entries(V3_WORDS)) {
      expect(Object.hasOwn(en, key), key).toBe(true);
      const want = ((en as Record<string, string>)[key].match(/\{\w+\}/g) ?? []).sort();
      expect((text!.match(/\{\w+\}/g) ?? []).sort(), key).toEqual(want);
      expect(text, key).not.toMatch(/\b(MCP|plugin|soul)\b/i);
    }
  });
});
