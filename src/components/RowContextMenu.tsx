// A small right-click menu for sidebar rows that have no menu of their own
// (people, shared rooms). Bot, room and thread rows keep their richer menus.
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export interface RowMenuItem { key: string; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean }
export interface RowMenuAt { x: number; y: number }

export function RowContextMenu({ at, label, items, onClose }: { at: RowMenuAt; label: string; items: RowMenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (element) {
      const { width, height } = element.getBoundingClientRect();
      element.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - width - 8))}px`;
      element.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - height - 8))}px`;
      element.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    }
    const down = (event: MouseEvent) => { if (!(event.target instanceof Node) || !ref.current?.contains(event.target)) onClose(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => { window.removeEventListener("mousedown", down); window.removeEventListener("keydown", key); window.removeEventListener("blur", onClose); };
  }, [at, onClose]);
  return createPortal(<div ref={ref} role="menu" aria-label={label} data-sidebar style={{ left: at.x, top: at.y }}
    className="fixed z-50 w-[220px] rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/60">
    {items.map(item => <button key={item.key} type="button" role="menuitem" disabled={item.disabled}
      onClick={() => { onClose(); item.onSelect(); }}
      className={cn("flex w-full items-center gap-3 px-3.5 py-2 text-left text-[14px] text-ink", item.disabled ? "cursor-default opacity-40" : "hover:bg-raised/70")}>
      {item.icon}{item.label}
    </button>)}
  </div>, document.body);
}

export function openRowMenu(event: React.MouseEvent, open: (at: RowMenuAt) => void) {
  event.preventDefault();
  open({ x: event.clientX, y: event.clientY });
}
