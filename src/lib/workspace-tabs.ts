import { browserAddress } from "./tools-panel";
export type WorkspaceTab = { id: string; kind: "home" | "browser" | "terminal" | "files" | "file"; title: string; url?: string; path?: string };
export type WorkspaceState = { tabs: WorkspaceTab[]; active: string };
export const newWorkspaceTab = (): WorkspaceTab => ({ id: crypto.randomUUID(), kind: "home", title: "New tab" });
export function workspaceStorageKey(botId: string, threadId: string): string {
  return `bos.workspace-tabs.v1:${encodeURIComponent(botId)}:${encodeURIComponent(threadId)}`;
}
export function safeWorkspacePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && !value.startsWith("/") && !/^[a-z]:/i.test(value) && !value.split(/[\\/]/).includes("..");
}
function safeURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try { const url = new URL(value); if (!["http:", "https:", "about:"].includes(url.protocol) || url.username || url.password || (url.protocol === "about:" && value !== "about:blank")) return; return browserAddress(value) ?? undefined; } catch { return; }
}
/** Persist navigation metadata only: never page contents, session state or credentials. */
export function sanitizeWorkspaceState(value: unknown): WorkspaceState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as {tabs?: unknown; active?: unknown};
  if (!Array.isArray(raw.tabs)) return null;
  const tabs: WorkspaceTab[] = [];
  for (const item of raw.tabs.slice(0, 24)) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || !/^[\w-]{1,80}$/.test(t.id) || tabs.some(tab => tab.id === t.id)) continue;
    if (!["home", "browser", "terminal", "files", "file"].includes(String(t.kind))) continue;
    const kind = t.kind as WorkspaceTab["kind"];
    const url = kind === "browser" ? safeURL(t.url) : undefined;
    if (kind === "browser" && !url) continue;
    if ((kind === "file" || kind === "files") && !safeWorkspacePath(t.path ?? "")) continue;
    tabs.push({ id: t.id, kind, title: typeof t.title === "string" ? [...t.title].filter(char => char.charCodeAt(0) >= 32).join("").slice(0, 120) : "New tab", ...(url ? {url} : {}), ...((kind === "file" || kind === "files") ? {path: String(t.path ?? "")} : {}) });
  }
  if (!tabs.length) return null;
  return {tabs, active: tabs.some(t => t.id === raw.active) ? String(raw.active) : tabs[0].id};
}
export function loadWorkspaceState(key: string): WorkspaceState {
  try { const raw = localStorage.getItem(key); if (raw && raw.length < 128 * 1024) { const state = sanitizeWorkspaceState(JSON.parse(raw)); if (state) return state; } } catch { /* unavailable storage */ }
  const tab = newWorkspaceTab(); return {tabs: [tab], active: tab.id};
}
