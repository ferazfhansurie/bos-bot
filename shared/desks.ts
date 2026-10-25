// Desks: one per app a bot works in (whatsapp, ads manager, gmail, a site
// admin). The person watches the app live beside the chat and works it
// through cards the bot writes in openui. Code is the layout the person
// customises by asking; data is what a refresh replaces, so a routine that
// updates numbers never clobbers a button the person asked for.

export type DeskKind = "browser" | "whatsapp";
export type DeskStatus = "needs_sign_in" | "ready";

export interface DeskCard {
  id: string;
  title: string;
  code: string;
  /** Plain json, drawn into the card as `data`. */
  data?: unknown;
  updatedAt: number;
}

export interface Desk {
  id: string;
  botId: string;
  /** The conversation the desk was last opened from; card buttons talk there. */
  threadId: string;
  name: string;
  kind: DeskKind;
  /** Where the person signs in and where bos works. Browser desks only. */
  url?: string;
  /** Lowercased host the live view matches browser tabs by. */
  host?: string;
  status: DeskStatus;
  pinned: boolean;
  cards: DeskCard[];
  createdAt: number;
  updatedAt: number;
  rev: number;
}

export const DESK_LIMITS = { desks: 12, cards: 20, code: 16_000, data: 32_000, name: 60, title: 80 } as const;

export const WHATSAPP_DESK_HOST = "web.whatsapp.com";

/** The openui a card draws: its code, plus its data as a `data = …` line
 * unless the code defines data itself. Json is valid openui. */
export function deskCardSource(card: Pick<DeskCard, "code" | "data">): string {
  if (card.data === undefined || /^\s*data\s*=/m.test(card.code)) return card.code;
  return `${card.code.trimEnd()}\ndata = ${JSON.stringify(card.data)}`;
}

/** The host a browser tab must be on to count as this desk's live view. */
export function deskHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:") return parsed.hostname.toLowerCase();
    // plain http only for a local fixture
    if (parsed.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)) return parsed.hostname;
    return null;
  } catch {
    return null;
  }
}

/** A tab on the desk's host, or one of its subdomains, is the desk's app. */
export function deskMatchesUrl(desk: Pick<Desk, "host">, url: string): boolean {
  if (!desk.host) return false;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  const base = desk.host.replace(/^www\./, "");
  return host === desk.host || host === base || host.endsWith(`.${base}`);
}
