import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from "@/components/canvas/canvas";
import { askBot } from "./v3-ask";

describe("askBot", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("opens the bot and fills only that thread's composer, and only if it is empty", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    const dispatch = vi.fn();
    const seen: ComposerInsertDetail[] = [];
    const listen = (event: Event) => seen.push((event as CustomEvent<ComposerInsertDetail>).detail);
    window.addEventListener(COMPOSER_INSERT_EVENT, listen);
    askBot(dispatch, { id: "bos", threadId: "t-main" }, "help me");
    vi.advanceTimersByTime(200);
    window.removeEventListener(COMPOSER_INSERT_EVENT, listen);
    expect(dispatch).toHaveBeenCalledWith({ type: "select", id: "bos" });
    expect(dispatch).toHaveBeenCalledWith({ type: "showChat" });
    expect(seen).toEqual([{ botId: "bos", threadId: "t-main", text: "help me", ifEmpty: true }]);
  });
});
