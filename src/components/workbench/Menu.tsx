/** The workbench's dropdown menu: a card of text rows with right-aligned
 * shortcuts, separators, submenus and custom rows (the zoom stepper). Used by
 * the thread "…" menu, the browser options menu and tab right-clicks.
 * Portalled to <body>; arrow keys move, → opens a submenu, ← and Escape back
 * out, and a click outside closes it. */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";

import { cn } from "@/lib/cn";
import type { TabIcon } from "@/components/workbench/registry";

export type MenuEntry =
  | {
    type?: "item";
    key: string;
    label: string;
    shortcut?: string;
    icon?: TabIcon;
    disabled?: boolean;
    danger?: boolean;
    checked?: boolean;
    /** Text after the label in a lighter tone (a count, the current value). */
    hint?: string;
    onSelect?: () => void;
    submenu?: MenuEntry[];
  }
  | { type: "separator"; key: string }
  | { type: "label"; key: string; label: string }
  | { type: "custom"; key: string; render: (close: () => void) => ReactNode };

export interface MenuAnchor { left: number; right: number; top: number; bottom: number }

export function anchorOf(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
}

export function pointAnchor(x: number, y: number): MenuAnchor {
  return { left: x, right: x, top: y, bottom: y };
}

const ROW = "flex h-8 w-full select-none items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] leading-5 outline-none";

export function Menu({ anchor, entries, label, onClose, onPicked, align = "start", side = "below", width = 248, className }: {
  anchor: MenuAnchor;
  entries: MenuEntry[];
  label: string;
  onClose: () => void;
  /** Closes the whole stack after a choice; submenus get the root's close. */
  onPicked?: () => void;
  align?: "start" | "end";
  /** "right": a submenu, opening beside its row. */
  side?: "below" | "right";
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<{ key: string; anchor: MenuAnchor } | null>(null);
  const root = side === "below";

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { width: w, height: h } = element.getBoundingClientRect();
    let left = side === "right" ? anchor.right + 4 : align === "end" ? anchor.right - w : anchor.left;
    if (side === "right" && left + w > window.innerWidth - 8) left = anchor.left - w - 4;
    let top = side === "right" ? anchor.top - 6 : anchor.bottom + 6;
    if (side === "below" && top + h > window.innerHeight - 8 && anchor.top - h - 6 > 8) top = anchor.top - h - 6;
    element.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(top, window.innerHeight - h - 8))}px`;
    element.style.visibility = "visible";
    if (root) element.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [anchor, align, side, root]);

  useEffect(() => {
    if (!root) return;
    const down = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-workbench-menu]")) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", onClose);
    };
  }, [root, onClose]);

  const move = (event: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(':scope > [role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
      next?.focus();
    } else if (event.key === "ArrowLeft" && !root) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div ref={ref} role="menu" aria-label={label} data-workbench-menu onKeyDown={move}
      style={{ width, visibility: "hidden" }}
      className={cn("fixed z-[70] flex max-h-[min(36rem,calc(100vh-16px))] flex-col overflow-y-auto rounded-2xl border border-ink/[.084] bg-menu p-1.5 text-ink shadow-[0_16px_48px_rgba(0,0,0,.45)] animate-pop-in", className)}>
      {entries.map((entry) => {
        if (entry.type === "separator") return <div key={entry.key} role="separator" className="mx-2.5 my-1.5 h-px shrink-0 bg-ink/[.084]" />;
        if (entry.type === "label") return <div key={entry.key} className="px-2.5 pb-1 pt-1.5 text-[12px] text-ink/50">{entry.label}</div>;
        if (entry.type === "custom") return <div key={entry.key}>{entry.render(onPicked ?? onClose)}</div>;
        const Icon = entry.icon;
        const expanded = open?.key === entry.key;
        const openSub = (element: HTMLElement) => setOpen({ key: entry.key, anchor: anchorOf(element) });
        return (
          <div key={entry.key} role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"} aria-checked={entry.checked}
            tabIndex={-1} aria-disabled={entry.disabled || undefined} aria-haspopup={entry.submenu ? "menu" : undefined} aria-expanded={entry.submenu ? expanded : undefined}
            onPointerEnter={(event) => { if (entry.disabled) return; event.currentTarget.focus(); if (entry.submenu) openSub(event.currentTarget); else setOpen(null); }}
            onClick={(event) => {
              if (entry.disabled) return;
              if (entry.submenu) { openSub(event.currentTarget); return; }
              (onPicked ?? onClose)();
              entry.onSelect?.();
            }}
            onKeyDown={(event) => {
              if (entry.disabled) return;
              if (event.key === "Enter" || event.key === " " || (event.key === "ArrowRight" && entry.submenu)) {
                event.preventDefault();
                event.currentTarget.click();
                if (entry.submenu) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-submenu-of="${entry.key}"] [role^="menuitem"]`)?.focus());
              }
            }}
            className={cn(ROW, "shrink-0 cursor-default",
              entry.disabled ? "text-ink/35" : entry.danger ? "text-danger focus:bg-ink/[.078]" : "focus:bg-ink/[.078]",
              expanded && "bg-ink/[.078]")}>
            {Icon && <Icon size={16} className="shrink-0 text-ink/70" />}
            <span className="min-w-0 flex-1 truncate">{entry.label}{entry.hint && <span className="ms-1.5 text-ink/50">{entry.hint}</span>}</span>
            {entry.checked && <Check size={15} className="shrink-0 text-ink/70" />}
            {entry.shortcut && <span className="shrink-0 text-[13px] tracking-wide text-ink/50">{entry.shortcut}</span>}
            {entry.submenu && <ChevronRight size={15} className="-me-0.5 shrink-0 text-ink/50" />}
          </div>
        );
      })}
      {open && (() => {
        const parent = entries.find((entry) => entry.key === open.key);
        if (!parent || parent.type === "separator" || parent.type === "label" || parent.type === "custom" || !parent.submenu) return null;
        return (
          <div data-submenu-of={parent.key}>
            <Menu anchor={open.anchor} entries={parent.submenu} label={parent.label} side="right" width={232}
              onClose={() => setOpen(null)} onPicked={onPicked ?? onClose} />
          </div>
        );
      })()}
    </div>,
    document.body,
  );
}
