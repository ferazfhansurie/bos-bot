// The owner's side of desks: read one or all of a bot's desks, pin and mark
// signed in, live through the server's desk frames (store.tsx turns them
// into bos-desk-changed events).
import { useCallback, useEffect, useState } from "react";

import type { Desk } from "../../../shared/desks";
import { api } from "@/state/store";

export const DESK_EVENT = "bos-desk-changed";

type DeskFrame = { kind: "desk"; botId: string; deskId: string; desk: Desk | null } | { kind: "desk.whatsapp"; held: boolean };

const base = (botId: string) => `/api/bots/${encodeURIComponent(botId)}/desks`;

export const deskApi = {
  list: (botId: string) => api<{ desks: Desk[] }>(base(botId)).then((r) => r.desks),
  get: (botId: string, id: string) => api<{ desk: Desk }>(`${base(botId)}/${id}`).then((r) => r.desk),
  patch: (botId: string, id: string, patch: Partial<Pick<Desk, "pinned" | "status" | "name">>) =>
    api<{ desk: Desk }>(`${base(botId)}/${id}`, { method: "PATCH", body: JSON.stringify(patch) }).then((r) => r.desk),
};

function onFrame(handler: (frame: DeskFrame) => void): () => void {
  const listener = (event: Event) => handler((event as CustomEvent<DeskFrame>).detail);
  window.addEventListener(DESK_EVENT, listener);
  return () => window.removeEventListener(DESK_EVENT, listener);
}

/** One desk, live. null once it is gone; undefined while loading. */
export function useDesk(botId: string, id: string): { desk: Desk | null | undefined; error: string; reload: () => void; set: (desk: Desk) => void } {
  const [desk, setDesk] = useState<Desk | null | undefined>(undefined);
  const [error, setError] = useState("");
  const reload = useCallback(() => {
    deskApi.get(botId, id).then((next) => { setDesk(next); setError(""); }, (e: unknown) => {
      if ((e as { status?: number }).status === 404) setDesk(null);
      else setError(e instanceof Error ? e.message : String(e));
    });
  }, [botId, id]);
  useEffect(() => { setDesk(undefined); reload(); }, [reload]);
  useEffect(() => onFrame((frame) => {
    if (frame.kind === "desk" && frame.botId === botId && frame.deskId === id) setDesk(frame.desk);
  }), [botId, id]);
  // frames sent while this window was asleep are lost; catch up on return
  useEffect(() => {
    const wake = () => { if (document.visibilityState === "visible") reload(); };
    document.addEventListener("visibilitychange", wake);
    return () => document.removeEventListener("visibilitychange", wake);
  }, [reload]);
  return { desk, error, reload, set: setDesk };
}

/** All of a bot's desks, live (the new tab's pinned list). */
export function useDesks(botId: string | undefined): Desk[] {
  const [desks, setDesks] = useState<Desk[]>([]);
  useEffect(() => {
    if (!botId) { setDesks([]); return; }
    let live = true;
    deskApi.list(botId).then((all) => { if (live) setDesks(all); }, () => { if (live) setDesks([]); });
    const off = onFrame((frame) => {
      if (frame.kind !== "desk" || frame.botId !== botId) return;
      setDesks((all) => {
        const rest = all.filter((desk) => desk.id !== frame.deskId);
        return frame.desk ? [...rest, frame.desk].sort((a, b) => a.createdAt - b.createdAt) : rest;
      });
    });
    return () => { live = false; off(); };
  }, [botId]);
  return desks;
}

/** Whether the owner has taken over WhatsApp (bos paused), live. */
export function useWhatsAppHold(): [boolean | undefined, (on: boolean) => Promise<void>] {
  const [held, setHeld] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    let live = true;
    api<{ held?: boolean }>("/api/whatsapp/native").then((r) => { if (live) setHeld(r.held === true); }, () => undefined);
    const off = onFrame((frame) => { if (frame.kind === "desk.whatsapp") setHeld(frame.held); });
    return () => { live = false; off(); };
  }, []);
  const set = useCallback(async (on: boolean) => {
    const r = await api<{ held: boolean }>("/api/whatsapp/native/hold", { method: "POST", body: JSON.stringify({ on }) });
    setHeld(r.held);
  }, []);
  return [held, set];
}
