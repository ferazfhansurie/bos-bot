/** Own the whole gesture, including releases outside the handle or renderer.
 * A synchronous shield keeps native guests/iframes from eating pointer input. */
export function startResizeDrag({ handle, pointerId, cursor, move, end }: {
  handle: HTMLElement;
  pointerId: number;
  cursor: "col-resize" | "row-resize";
  move: (event: PointerEvent) => void;
  end: (cancelled: boolean) => void;
}): () => void {
  const doc = handle.ownerDocument;
  const win = doc.defaultView!;
  const body = doc.body;
  const previousCursor = body.style.cursor;
  const previousSelect = body.style.userSelect;
  const shield = doc.createElement("div");
  shield.setAttribute("aria-hidden", "true");
  shield.setAttribute("data-resize-shield", "");
  Object.assign(shield.style, { position: "fixed", inset: "0", zIndex: "2147483647", cursor, touchAction: "none" });
  body.appendChild(shield);
  body.style.cursor = cursor;
  body.style.userSelect = "none";
  let finished = false;
  const finish = (cancelled: boolean) => {
    if (finished) return;
    finished = true;
    win.removeEventListener("pointermove", onMove, { capture: true });
    win.removeEventListener("pointerup", onUp, { capture: true });
    win.removeEventListener("pointercancel", onCancel, { capture: true });
    handle.removeEventListener("lostpointercapture", cancel);
    win.removeEventListener("blur", cancel);
    win.removeEventListener("keydown", onKey, { capture: true });
    doc.removeEventListener("visibilitychange", onVisibility);
    shield.remove();
    body.style.cursor = previousCursor;
    body.style.userSelect = previousSelect;
    if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    end(cancelled);
  };
  const cancel = () => finish(true);
  const onMove = (event: PointerEvent) => {
    if (finished || event.pointerId !== pointerId) return;
    // A release swallowed by a native guest can leave capture alive.
    if (event.buttons === 0) { finish(false); return; }
    event.preventDefault();
    move(event);
  };
  const onUp = (event: PointerEvent) => {
    if (finished || event.pointerId !== pointerId) return;
    move(event);
    finish(false);
  };
  const onCancel = (event: PointerEvent) => { if (event.pointerId === pointerId) cancel(); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };
  const onVisibility = () => { if (doc.hidden) cancel(); };
  win.addEventListener("pointermove", onMove, { capture: true });
  win.addEventListener("pointerup", onUp, { capture: true });
  win.addEventListener("pointercancel", onCancel, { capture: true });
  handle.addEventListener("lostpointercapture", cancel);
  win.addEventListener("blur", cancel);
  win.addEventListener("keydown", onKey, { capture: true });
  doc.addEventListener("visibilitychange", onVisibility);
  try { handle.setPointerCapture(pointerId); } catch { /* window listeners still own the gesture */ }
  return cancel;
}
