// The custom mascot colour picker's save rules. On macOS Electron the native
// panel streams input events and may never send "change", so a pick must
// save on a pause, on change, and on blur/unmount — each colour once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createColorPickCommitter } from "./color-pick-commit";

describe("createColorPickCommitter", () => {
  let saved: string;
  let save: ReturnType<typeof vi.fn<(value: string) => void>>;
  const make = () =>
    createColorPickCommitter({
      saved: () => saved,
      save: (value) => {
        save(value);
        saved = value; // the store applies a save optimistically
      },
    });

  beforeEach(() => {
    vi.useFakeTimers();
    saved = "#009957";
    save = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it("saves after a quiet period even when change never fires", () => {
    const committer = make();
    committer.draft("#1a2b3c");
    vi.advanceTimersByTime(399);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledExactlyOnceWith("#1A2B3C");
    expect(committer.pending()).toBe(false);
  });

  it("coalesces a drag into the last colour shown", () => {
    const committer = make();
    for (const value of ["#111111", "#222222", "#333333"]) {
      committer.draft(value);
      vi.advanceTimersByTime(100);
    }
    vi.advanceTimersByTime(400);
    expect(save).toHaveBeenCalledExactlyOnceWith("#333333");
  });

  it("change/blur flush immediately and the timer does not save it again", () => {
    const committer = make();
    committer.draft("#abcdef");
    committer.flush();
    expect(save).toHaveBeenCalledExactlyOnceWith("#ABCDEF");
    vi.advanceTimersByTime(1000);
    committer.draft("#abcdef"); // the trailing "change" with the same value
    committer.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("never saves the colour that is already saved", () => {
    saved = "#377FE6"; // a bot on palette "blue" resolves to this hex
    const committer = make();
    committer.draft("#377fe6");
    committer.flush();
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it("flush with nothing pending is a no-op; cancel drops a pending pick", () => {
    const committer = make();
    committer.flush();
    committer.draft("#123456");
    committer.cancel();
    vi.advanceTimersByTime(1000);
    committer.flush();
    expect(save).not.toHaveBeenCalled();
  });
});
