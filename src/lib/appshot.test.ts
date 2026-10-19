import { describe, expect, it } from "vitest";
import { APPSHOT_SHORTCUT, moveSelection, shortcutKeys } from "./appshot";
import { APPSHOT_SHORTCUT as SHELL_SHORTCUT } from "../../electron/appshot.mjs";

describe("appshot", () => {
  it("renderer and shell agree on the shortcut", () => {
    expect(APPSHOT_SHORTCUT).toBe(SHELL_SHORTCUT);
  });
  it("formats the accelerator per platform", () => {
    expect(shortcutKeys(APPSHOT_SHORTCUT, true)).toEqual(["⌘", "⇧", "2"]);
    expect(shortcutKeys(APPSHOT_SHORTCUT, false)).toEqual(["Ctrl", "Shift", "2"]);
  });
  it("moves the picker selection within the grid", () => {
    expect(moveSelection(0, "ArrowRight", 5, 3)).toBe(1);
    expect(moveSelection(0, "ArrowLeft", 5, 3)).toBe(0);
    expect(moveSelection(1, "ArrowDown", 5, 3)).toBe(4);
    expect(moveSelection(4, "ArrowDown", 5, 3)).toBe(4);
    expect(moveSelection(4, "ArrowUp", 5, 3)).toBe(1);
    expect(moveSelection(-1, "ArrowRight", 0, 3)).toBe(-1);
  });
});
