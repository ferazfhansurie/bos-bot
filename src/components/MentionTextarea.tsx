import { useCallback, useLayoutEffect, useRef, type RefObject, type TextareaHTMLAttributes } from "react";
import { type MentionPeer } from "@/lib/mentions";
import { MentionText } from "./MentionText";

let twinEl: HTMLTextAreaElement | null = null;
function measureTwin(input: HTMLTextAreaElement, style: CSSStyleDeclaration): HTMLTextAreaElement {
  if (!twinEl || !twinEl.isConnected) {
    twinEl = document.createElement("textarea");
    twinEl.setAttribute("aria-hidden", "true");
    twinEl.tabIndex = -1;
    Object.assign(twinEl.style, { position: "absolute", top: "0", left: "-9999px", visibility: "hidden", overflow: "hidden", height: "0", minHeight: "0", transition: "none" });
    document.body.appendChild(twinEl);
  }
  const twin = twinEl;
  twin.style.boxSizing = "content-box";
  for (const key of ["font", "letterSpacing", "lineHeight", "paddingTop", "paddingBottom", "paddingLeft", "paddingRight", "whiteSpace", "wordBreak", "overflowWrap", "tabSize", "direction"] as const) {
    twin.style[key] = style[key];
  }
  // clientWidth includes horizontal padding; content-box width must not.
  twin.style.width = `${input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`;
  twin.value = input.value;
  return twin;
}

/** A native textarea retains selection, undo, IME and accessibility. Its
 * aria-hidden mirror paints mentions without changing wrapping or caret offsets. */
export function MentionTextarea({ inputRef, peers, everyone = false, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  peers: readonly MentionPeer[];
  everyone?: boolean;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const sync = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    mirror.style.width = `${input.clientWidth}px`;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  }, [inputRef]);
  const resize = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    const scrollTop = input.scrollTop;
    const style = getComputedStyle(input);
    const line = parseFloat(style.lineHeight) || 24;
    // Measure on an offscreen twin so the real textarea never passes through
    // height:auto; going px to px lets its height ease instead of snapping.
    const twin = measureTwin(input, style);
    input.style.height = `${Math.min(twin.scrollHeight, line * 6)}px`;
    input.scrollTop = scrollTop;
    sync();
  }, [inputRef, sync]);
  useLayoutEffect(resize, [props.value, resize]);
  useLayoutEffect(() => {
    let width = inputRef.current?.clientWidth;
    const observer = new ResizeObserver(() => {
      // Width changes can wrap an unchanged draft onto more lines. Observe
      // width only so setting the measured height cannot create a resize loop.
      const nextWidth = inputRef.current?.clientWidth;
      if (nextWidth !== width) { width = nextWidth; resize(); }
      else sync();
    });
    if (inputRef.current) observer.observe(inputRef.current);
    return () => observer.disconnect();
  }, [inputRef, resize, sync]);
  return <div className="mention-editor relative min-w-0 flex-1 self-center">
    <div ref={mirrorRef} dir={props.dir} aria-hidden="true" className="mention-editor-mirror pointer-events-none absolute inset-0 overflow-hidden">
      <MentionText text={String(props.value ?? "")} peers={peers} everyone={everyone} />{"\n"}
    </div>
    <textarea {...props} ref={inputRef} onScroll={(event) => { sync(); props.onScroll?.(event); }} />
  </div>;
}
