import { useSyncExternalStore } from "react";

export interface SharedDeliverySnapshot {
  text: string; files: File[]; replyTo?: string; sendId: string;
}
interface SharedDeliveryState {
  files: File[]; status: "draft" | "sending" | "failed" | "sent"; error: string;
}

/** Conversation-owned delivery state outlives the mounted composer. The exact
 * request id survives an uncertain acknowledgement and navigation. */
export class SharedDelivery {
  private state: SharedDeliveryState = { files: [], status: "draft", error: "" };
  private attempt?: SharedDeliverySnapshot;
  private readonly listeners = new Set<() => void>();
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<SharedDeliveryState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  edit() { if (this.state.status !== "sending") this.update({ status: "draft", error: "" }); }
  setFiles(change: (files: File[]) => File[]) { this.update({ files: change(this.state.files) }); this.edit(); }
  async send(text: string, replyTo: string | undefined, deliver: (snapshot: SharedDeliverySnapshot) => Promise<void>, accepted: () => void): Promise<boolean> {
    if (this.state.status === "sending") return false;
    const files = [...this.state.files];
    const previous = this.attempt;
    const same = previous?.text === text && previous.replyTo === replyTo && previous.files.length === files.length && files.every((file, index) => file === previous.files[index]);
    const snapshot = { text, replyTo, files, sendId: same ? previous!.sendId : crypto.randomUUID() };
    this.attempt = snapshot;
    this.update({ status: "sending", error: "" });
    try {
      await deliver(snapshot);
      accepted();
      this.attempt = undefined;
      this.update({ status: "sent", files: this.state.files.filter(file => !files.includes(file)), error: "" });
      return true;
    } catch (error) {
      this.update({ status: "failed", error: error instanceof Error ? error.message : "Connection unavailable." });
      return false;
    }
  }
}
const deliveries = new Map<string, SharedDelivery>();
export function sharedDelivery(key: string): SharedDelivery {
  let delivery = deliveries.get(key);
  if (!delivery) { delivery = new SharedDelivery(); deliveries.set(key, delivery); }
  return delivery;
}
export function useSharedDelivery(key: string) {
  const delivery = sharedDelivery(key);
  const state = useSyncExternalStore(delivery.subscribe, delivery.getSnapshot, delivery.getSnapshot);
  return { delivery, ...state };
}
