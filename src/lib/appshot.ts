/**
 * Appshots in the renderer: which composer receives the picked window, and
 * the picker's open state. The desktop shell lists and captures windows
 * (electron/appshot.mjs); this side only shows the picker and turns the
 * capture into a File for the composer's normal attachment path.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/** Mirrors electron/appshot.mjs APPSHOT_SHORTCUT (the menu hint shows it
 * before the shell reports whether registration succeeded). */
export const APPSHOT_SHORTCUT = "CommandOrControl+Shift+2";

export type AppshotOpen = AppshotListing & { source: "menu" | "shortcut" };
type Target = (file: File) => void;

const targets: { id: number; attach: Target }[] = [];
let nextId = 1;
let open: AppshotOpen | null = null;
const listeners = new Set<() => void>();
let unsubscribeShortcut: (() => void) | null = null;

function emit() { for (const listener of listeners) listener(); }

export function appshotsAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.ogb?.appshot);
}

/** The most recently mounted composer is the one appshots land in. */
export function registerAppshotTarget(attach: Target): () => void {
  const entry = { id: nextId++, attach };
  targets.push(entry);
  // The shortcut can fire before any composer mounts; the listing waits in
  // `open` until one does.
  if (!unsubscribeShortcut && appshotsAvailable()) {
    unsubscribeShortcut = window.ogb!.appshot!.onOpen((listing) => showAppshotPicker({ ...listing, source: "shortcut" }));
  }
  emit();
  return () => {
    const index = targets.indexOf(entry);
    if (index >= 0) targets.splice(index, 1);
    emit();
  };
}

export function showAppshotPicker(listing: AppshotOpen) { open = listing; emit(); }
export function closeAppshotPicker() { open = null; emit(); }

/** Lists windows for the attach menu. */
export async function openAppshotPicker(): Promise<void> {
  const listing = await window.ogb?.appshot?.list();
  if (listing) showAppshotPicker({ ...listing, source: "menu" });
}

/** Captures the picked source and hands it to the current composer. */
export async function attachAppshot(id: string): Promise<void> {
  const bridge = window.ogb?.appshot;
  const target = targets.at(-1);
  if (!bridge || !target) throw new Error("Open a chat to attach an appshot.");
  const { name, data } = await bridge.capture(id);
  target.attach(new File([new Uint8Array(data)], name, { type: "image/png" }));
}

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
const topTargetId = () => targets.at(-1)?.id ?? 0;
const currentListing = () => open;

/**
 * Registers a composer as an appshot target while `enabled`, and returns the
 * picker listing only to the composer that is currently on top, so exactly
 * one picker renders.
 */
export function useAppshotHost(attach: Target, enabled: boolean): AppshotOpen | null {
  const latest = useRef(attach);
  latest.current = attach;
  const [myId, setMyId] = useState(0);
  useEffect(() => {
    if (!enabled || !appshotsAvailable()) return;
    const off = registerAppshotTarget((file) => latest.current(file));
    setMyId(topTargetId());
    return () => { off(); setMyId(0); };
  }, [enabled]);
  const top = useSyncExternalStore(subscribe, topTargetId, () => 0);
  const listing = useSyncExternalStore(subscribe, currentListing, () => null);
  return myId !== 0 && top === myId ? listing : null;
}

/** "CommandOrControl+Shift+2" -> ["⌘","⇧","2"] on mac, ["Ctrl","Shift","2"] elsewhere. */
export function shortcutKeys(accelerator: string, mac: boolean): string[] {
  const names: Record<string, [string, string]> = {
    commandorcontrol: ["⌘", "Ctrl"], cmdorctrl: ["⌘", "Ctrl"], command: ["⌘", "Cmd"], cmd: ["⌘", "Cmd"],
    control: ["⌃", "Ctrl"], ctrl: ["⌃", "Ctrl"], shift: ["⇧", "Shift"], alt: ["⌥", "Alt"], option: ["⌥", "Alt"],
  };
  return accelerator.split("+").filter(Boolean).map((part) => names[part.toLowerCase()]?.[mac ? 0 : 1] ?? part.toUpperCase());
}

/** Picker keyboard movement over a grid of `count` cards, `columns` wide. */
export function moveSelection(index: number, key: string, count: number, columns: number): number {
  if (count <= 0) return -1;
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : key === "ArrowDown" ? columns : key === "ArrowUp" ? -columns : 0;
  return Math.min(count - 1, Math.max(0, index + step));
}
