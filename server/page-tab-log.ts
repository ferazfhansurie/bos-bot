// The pages a bot opened beside a conversation with open_tab (or app_create),
// remembered per thread so the phone can list them after the fact: the
// desktop shows a page the moment the workspace.open frame arrives, but a
// phone may be asleep then. Only folder-relative paths and titles are kept;
// the html itself is always read fresh from the bot's folder.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export type PageTabEntry = { path: string; title?: string; appId?: string; openedAt: number };

/** Newest pages kept per thread. A thread rarely opens more than a few. */
export const PAGE_TABS_PER_THREAD = 20;

export class PageTabLog {
  private data: Record<string, PageTabEntry[]> = {};
  private loaded = false;
  private file: string | null;
  constructor(file: string | null) { this.file = file; }

  private load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.file) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) this.data = parsed as Record<string, PageTabEntry[]>;
    } catch { /* first run, or unreadable: start empty */ }
  }

  private save() {
    if (!this.file) return;
    try {
      writeFileSync(this.file + ".tmp", JSON.stringify(this.data), { mode: 0o600 });
      renameSync(this.file + ".tmp", this.file);
    } catch { /* the tab still opened; the phone just won't list it */ }
  }

  /** A page was opened: it moves to the front, keeping one entry per path. */
  record(botId: string, threadId: string, entry: Omit<PageTabEntry, "openedAt">, now = Date.now()) {
    this.load();
    const key = `${botId} ${threadId}`;
    const rest = (this.data[key] ?? []).filter(item => item.path !== entry.path);
    const title = entry.title?.trim().slice(0, 120);
    this.data[key] = [{ path: entry.path, ...(title ? { title } : {}), ...(entry.appId ? { appId: entry.appId } : {}), openedAt: now }, ...rest].slice(0, PAGE_TABS_PER_THREAD);
    this.save();
  }

  /** Newest first. */
  list(botId: string, threadId: string): PageTabEntry[] {
    this.load();
    return [...(this.data[`${botId} ${threadId}`] ?? [])];
  }

  /** Was this path opened in this thread? The page route serves nothing else. */
  has(botId: string, threadId: string, path: string): boolean {
    return this.list(botId, threadId).some(item => item.path === path);
  }
}
