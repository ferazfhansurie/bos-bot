// 3.0 check-ins on the client: the today list the chief proposes three times
// a day, and the person's taps on it. One shared snapshot for the sidebar row,
// the today screen and the chat card. Plain fetch, no store import, so the
// chat card can carry it into any bundle that draws cards.
import { useEffect, useSyncExternalStore } from "react";
import type { CheckinAction, CheckinItem, CheckinsSnapshot } from "../../shared/checkins";

export interface CheckinsState {
  snapshot: CheckinsSnapshot | null;
  error: string | null;
  loading: boolean;
  /** Item ids with a tap on the way to the server. */
  busy: ReadonlySet<string>;
}

let state: CheckinsState = { snapshot: null, error: null, loading: false, busy: new Set() };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;
let stale = false;

function set(patch: Partial<CheckinsState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : `HTTP ${res.status}`);
  return body as T;
}

export function loadCheckins(): Promise<void> {
  if (inflight) { stale = true; return inflight; }
  set({ loading: true });
  inflight = request<CheckinsSnapshot>("/api/checkins")
    .then((snapshot) => set({ snapshot, error: null }))
    .catch((error: unknown) => set({ error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      inflight = null;
      set({ loading: false });
      if (stale) { stale = false; void loadCheckins(); }
    });
  return inflight;
}

/** The server said the list changed: refetch only if something shows it. */
export function checkinsChanged(): void {
  if (listeners.size) void loadCheckins();
}

export async function actOnCheckin(id: string, action: CheckinAction): Promise<CheckinItem | null> {
  if (state.busy.has(id)) return null;
  set({ busy: new Set([...state.busy, id]) });
  try {
    const body = await request<CheckinsSnapshot & { item: CheckinItem }>(`/api/checkins/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" });
    set({ snapshot: { items: body.items, counts: body.counts, setUp: body.setUp, chiefBotId: body.chiefBotId, slots: body.slots }, error: null });
    return body.item;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    const busy = new Set(state.busy);
    busy.delete(id);
    set({ busy });
  }
}

export async function setupCheckins(): Promise<boolean> {
  try {
    const snapshot = await request<CheckinsSnapshot>("/api/checkins/setup", { method: "POST", body: "{}" });
    set({ snapshot, error: null });
    return true;
  } catch (error) {
    set({ error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const read = () => state;

/** The shared today list; loads it on first use while `enabled`. */
export function useCheckins(enabled = true): CheckinsState {
  const current = useSyncExternalStore(subscribe, read, read);
  useEffect(() => {
    if (enabled && !state.snapshot && !inflight) void loadCheckins();
  }, [enabled]);
  return current;
}

/** Items still asking for a tap, ranked by the server (snoozed ones that
 * came back are in here too). */
export function openItems(snapshot: CheckinsSnapshot | null): CheckinItem[] {
  return snapshot?.items ?? [];
}

/** Share of today's list already cleared, for the ring (0..1). */
export function clearedShare(snapshot: CheckinsSnapshot | null): number {
  if (!snapshot) return 0;
  const open = openItems(snapshot).length;
  const cleared = snapshot.counts.done + snapshot.counts.no;
  return open + cleared === 0 ? 0 : cleared / (open + cleared);
}

export const CHECKIN_SLOT_HOURS = { morning: 9, afternoon: 14, night: 22 } as const;

/** The next check-in after `now`, in this device's clock, or null if none is set up. */
export function nextCheckinAt(snapshot: CheckinsSnapshot | null, now = Date.now()): number | null {
  if (!snapshot?.setUp || !snapshot.slots.length) return null;
  const hours = snapshot.slots.map((slot) => CHECKIN_SLOT_HOURS[slot]).sort((a, b) => a - b);
  const day = new Date(now);
  for (const hour of hours) {
    const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour).getTime();
    if (at > now) return at;
  }
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, hours[0]).getTime();
}

export function greetingFor(now = Date.now()): "morning" | "afternoon" | "evening" {
  const hour = new Date(now).getHours();
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}
