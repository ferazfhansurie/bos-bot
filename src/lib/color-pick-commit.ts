/** Save logic for a native `<input type="color">`, kept out of React so it
 * can be tested without a DOM.
 *
 * The system picker (NSColorPanel on macOS) streams `input` events while the
 * person drags, and Electron does not reliably fire `change` when the panel
 * closes — it may never close at all if they just click back into the app.
 * So a pick is saved three ways, whichever comes first: after `delayMs` of
 * quiet, on `change`, and on blur/unmount. Each distinct colour is saved
 * once, and re-picking the colour that is already saved is a no-op (so a
 * palette name like "blue" is never rewritten to its own hex). */
export interface ColorPickCommitter {
  /** A live value from the picker (`input`). Schedules a save. */
  draft: (value: string) => void;
  /** Save any pending value now (`change`, blur, unmount). */
  flush: () => void;
  /** True while a picked value is waiting to be saved. */
  pending: () => boolean;
  /** Drop a pending value without saving. */
  cancel: () => void;
}

export function createColorPickCommitter(options: {
  /** The saved colour as uppercase #RRGGBB. Read at save time. */
  saved: () => string;
  save: (value: string) => void;
  delayMs?: number;
}): ColorPickCommitter {
  const delayMs = options.delayMs ?? 400;
  let pending: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const flush = () => {
    clearTimer();
    const value = pending;
    pending = null;
    if (value !== null && value !== options.saved()) options.save(value);
  };

  return {
    draft(value) {
      pending = value.toUpperCase();
      clearTimer();
      timer = setTimeout(flush, delayMs);
    },
    flush,
    pending: () => pending !== null,
    cancel() {
      clearTimer();
      pending = null;
    },
  };
}
