// 3.0: undo instead of "are you sure". Archive, mark done, mute and quick
// setting changes happen at once and offer undo. Delete waits: the thing is
// hidden now and only goes for real when the toast runs out, so undo is a
// true undo. One toast at a time; a new one lets the previous one finish.
import { useSyncExternalStore } from "react";

export const UNDO_MS = 6000;

export type UndoToast = {
  id: number;
  text: string;
  /** puts things back; called instead of commit */
  undo?: () => void;
  /** the deferred part (a delete); runs when the toast ends without undo */
  commit?: () => void;
  /** hidden until commit or undo, e.g. a thread row being deleted */
  pending?: string;
};

let current: UndoToast | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function finish(commit: boolean) {
  const toast = current;
  if (!toast) return;
  clearTimeout(timer);
  timer = undefined;
  current = null;
  emit();
  try {
    if (commit) toast.commit?.();
    else toast.undo?.();
  } catch (cause) {
    console.error("undo toast", cause);
  }
}

/** Show "<text> · Undo". Returns the toast id. */
export function showUndo(text: string, options: Omit<UndoToast, "id" | "text"> = {}, ms = UNDO_MS): number {
  finish(true);
  const toast: UndoToast = { id: nextId++, text, ...options };
  current = toast;
  timer = setTimeout(() => finish(true), ms);
  emit();
  return toast.id;
}

export function undoNow(id: number): void {
  if (current?.id === id) finish(false);
}

export function dismissUndo(id: number): void {
  if (current?.id === id) finish(true);
}

/** leaving the app keeps what the person did: run the deferred part now */
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("pagehide", () => finish(true));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const snapshot = () => current;

export function useUndoToast(): UndoToast | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** True while something with this key waits on its undo toast. */
export function usePendingUndo(key: string): boolean {
  const toast = useSyncExternalStore(subscribe, snapshot, snapshot);
  return toast?.pending === key;
}

/** test seam */
export function __resetUndo(): void {
  clearTimeout(timer);
  timer = undefined;
  current = null;
  emit();
}
