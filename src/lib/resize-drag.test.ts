import { describe, expect, it, vi } from "vitest";

import { startResizeDrag } from "./resize-drag";

function fixture() {
  const win = new EventTarget();
  const doc = new EventTarget();
  const shield = { style: {}, setAttribute: vi.fn(), remove: vi.fn() };
  const body = { style: { cursor: "crosshair", userSelect: "text" }, appendChild: vi.fn() };
  Object.assign(doc, { defaultView: win, body, hidden: false, createElement: () => shield });
  const handle = new EventTarget();
  let captured = false;
  const release = vi.fn(() => { captured = false; handle.dispatchEvent(new Event("lostpointercapture")); });
  Object.assign(handle, { ownerDocument: doc, setPointerCapture: () => { captured = true; }, hasPointerCapture: () => captured, releasePointerCapture: release });
  const move = vi.fn();
  const end = vi.fn();
  const cancel = startResizeDrag({ handle: handle as HTMLElement, pointerId: 7, cursor: "col-resize", move, end });
  const pointer = (type: string, pointerId = 7, buttons = 1) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId, buttons, clientX: 300 });
    win.dispatchEvent(event);
  };
  return { win, doc, handle, body, shield, release, move, end, cancel, pointer };
}

describe("resize gesture ownership", () => {
  it("handles release away from the handle, ignores other pointers and restores styles", () => {
    const f = fixture();
    expect(f.body.style.cursor).toBe("col-resize");
    f.pointer("pointermove", 9);
    expect(f.move).not.toHaveBeenCalled();
    f.pointer("pointermove");
    f.pointer("pointerup");
    expect(f.move).toHaveBeenCalledTimes(2);
    expect(f.end).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.shield.remove).toHaveBeenCalledOnce();
    expect(f.body.style).toEqual({ cursor: "crosshair", userSelect: "text" });
    f.pointer("pointermove");
    f.cancel();
    expect(f.move).toHaveBeenCalledTimes(2);
    expect(f.end).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "blur", "lostpointercapture", "visibilitychange", "Escape", "unmount"])("cleans up after %s", (reason) => {
    const f = fixture();
    if (reason === "pointercancel") f.pointer(reason);
    else if (reason === "lostpointercapture") f.handle.dispatchEvent(new Event(reason));
    else if (reason === "visibilitychange") { Object.assign(f.doc, { hidden: true }); f.doc.dispatchEvent(new Event(reason)); }
    else if (reason === "Escape") { const e = new Event("keydown", { cancelable: true }); Object.assign(e, { key: "Escape" }); f.win.dispatchEvent(e); expect(e.defaultPrevented).toBe(true); }
    else if (reason === "unmount") f.cancel();
    else f.win.dispatchEvent(new Event(reason));
    expect(f.end).toHaveBeenCalledExactlyOnceWith(true);
    expect(f.shield.remove).toHaveBeenCalledOnce();
    expect(f.body.style.cursor).toBe("crosshair");
    f.pointer("pointerup");
    expect(f.end).toHaveBeenCalledOnce();
  });

  it("ends on a buttons-free move after a native guest swallowed the release", () => {
    const f = fixture();
    f.pointer("pointermove", 7, 0);
    expect(f.end).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.move).not.toHaveBeenCalled();
  });
});
