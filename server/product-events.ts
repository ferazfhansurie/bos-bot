/** Single host-owned sender. Lanes may report an actual outcome without importing the server. */
let record: (name: string, props?: Record<string, unknown>) => void = () => {};
export function bindProductEvents(sender: typeof record): void { record = sender; }
export function recordProductEvent(name: string, props?: Record<string, unknown>): void {
  try { record(name, props); } catch { /* Reporting cannot fail the operation being observed. */ }
}
