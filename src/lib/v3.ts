// bos bot 3.0 sits behind one switch. Since 3.0.0 it is on for everyone
// unless the person turned it off. Off, nothing here changes the page: no
// attribute is stamped and every v3 surface renders exactly what it rendered
// before.
//
// Three ways to set it, strongest first:
//   - a build or dev server started with BOS_V3=1 (or BOS_V3=0 to force it off)
//   - `?v3=1` / `?v3=0` in the url, remembered for next time
//   - the 3.0 switch in settings → updates
//
// The workspace config keeps a mirror (features.v3) so paired phones follow
// the mac. It is only ever written from here.
import { useSyncExternalStore } from "react";

declare const __BOS_V3__: boolean | null | undefined;

// "0" = the person turned 3.0 off; anything else (unset, or the "1" a labs
// install wrote before 3.0.0) is on.
const KEY = "bos-v3";
const REDUCE_KEY = "bos-reduce-transparency";

function store(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function read(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) store()?.removeItem(key);
    else store()?.setItem(key, value);
  } catch {
    /* private mode: the choice holds for this session only */
  }
}

/** The build's say, when it has one. */
function forced(): boolean | null {
  return typeof __BOS_V3__ === "boolean" ? __BOS_V3__ : null;
}

export function v3Forced(): boolean {
  return forced() !== null;
}

export function v3Enabled(): boolean {
  return forced() ?? read(KEY) !== "0";
}

export function reduceTransparency(): boolean {
  return read(REDUCE_KEY) === "1";
}

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stamp(): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (v3Enabled()) root.dataset.v3 = "";
  else delete root.dataset.v3;
  if (v3Enabled() && reduceTransparency()) root.dataset.reduceTransparency = "";
  else delete root.dataset.reduceTransparency;
}

/** Tell the server, so phones paired to this workspace follow. Best effort:
 * a missed write only means the phone keeps its old look until the next
 * switch or launch. Plain fetch, not the store's api(), to keep this module
 * free of the store. */
async function mirror(on: boolean, onlyIfDifferent: boolean): Promise<void> {
  if (typeof fetch === "undefined") return;
  try {
    if (onlyIfDifferent) {
      const res = await fetch("/api/config");
      if (!res.ok) return;
      const body = await res.json() as { features?: { v3?: boolean } };
      if ((body.features?.v3 !== false) === on) return;
    }
    await fetch("/api/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ features: { v3: on } }),
    });
  } catch {
    /* offline or not served by a bos server */
  }
}

/** Before the first paint: take a `?v3=` from the url, then stamp the root. */
export function initV3(): void {
  try {
    const param = new URLSearchParams(location.search).get("v3");
    if (param === "1" || param === "0") write(KEY, param === "1" ? null : "0");
  } catch {
    /* no location outside a browser */
  }
  stamp();
  // catch the server up so a paired phone matches, whichever way it is
  void mirror(v3Enabled(), true);
}

export function setV3(on: boolean): void {
  write(KEY, on ? null : "0");
  stamp();
  emit();
  void mirror(on, false);
}

export function setReduceTransparency(on: boolean): void {
  write(REDUCE_KEY, on ? "1" : null);
  stamp();
  emit();
}

export function useV3(): boolean {
  return useSyncExternalStore(subscribe, v3Enabled, () => false);
}

export function useReduceTransparency(): boolean {
  return useSyncExternalStore(subscribe, reduceTransparency, () => false);
}
