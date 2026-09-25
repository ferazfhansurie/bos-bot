// BOS Bot personal edition never sends product analytics or identity data.
export function analyticsEnabled(): boolean { return false }

export type OptAction = "init" | "opt-in" | "opt-out" | "none";
export function optAction(_enabled: boolean, _running: boolean): OptAction { return "none" }
export function setAnalyticsEnabled(_enabled: boolean): void {}
export function initAnalytics(): void {}
export function track(_event: string, _props?: Record<string, unknown>): void {}
export function identifyEmail(_email: string): void {}

const GATE_KEY = "bos-email-gate";
export function emailGateDone(): boolean {
  return Boolean(localStorage.getItem(GATE_KEY));
}
export function setEmailGateDone(status: "submitted" | "skipped"): void {
  localStorage.setItem(GATE_KEY, status);
}
