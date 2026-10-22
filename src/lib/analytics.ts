import { api } from "@/state/store";
import { productEvent } from "../../shared/product-events";

let enabled = false;
let typedEmail = "";
export function analyticsEnabled(): boolean { return enabled; }

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(next: boolean, running: boolean): OptAction { return next === running ? "none" : next ? "opt-in" : "opt-out"; }
/** Called after the shared anonymous-usage setting has been saved. The server rechecks it on every event. */
export function setAnalyticsEnabled(next: boolean): void { enabled = next; if (!next) typedEmail = ""; }
export async function initAnalytics(): Promise<void> {
  try { const product = await api<{ analyticsEnabled: boolean }>("/api/product"); setAnalyticsEnabled(product.analyticsEnabled === true); }
  catch { setAnalyticsEnabled(false); }
}
export function track(name: string, props?: Record<string, unknown>): void {
  if (!enabled) return;
  const event = productEvent(name, props); if (!event) return;
  // The local server owns the install id, durable batch, 60s timer and quit flush.
  void api("/api/product/events", { method: "POST", body: JSON.stringify({ events: [{ name: event.name, props: event.props }] }) }).catch(() => {});
  if (name === "onboarding_completed" && typedEmail) {
    const email = typedEmail; typedEmail = "";
    void api("/api/product/claim", { method: "POST", body: JSON.stringify({ email }) }).catch(() => {});
  }
}
/** Only the email just typed in onboarding may be claimed; never inspect old config. */
export function identifyEmail(email: string): void {
  if (enabled && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) typedEmail = email.trim().toLowerCase();
}

const GATE_KEY = "bos-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped"): void {
  localStorage.setItem(GATE_KEY, status);
}
