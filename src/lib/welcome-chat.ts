// "Say hi to Firaz" after first run. The app server asks bos.aihlete.com for
// a one-time guest link (server/welcome-chat.ts); this maps its answer to
// what the card does: open the chat, ask to try later, or quietly go away.

export type HelloOutcome =
  | { kind: "open"; url: string }
  /** 429: too many hellos from here today; the card stays with a retry. */
  | { kind: "later"; message: string }
  /** 503 or anything unexpected: Firaz's server is off, the card hides. */
  | { kind: "hide" };

type Request = (path: string, init: RequestInit & { timeoutMs?: number }) => Promise<{ url?: unknown }>;

export const HELLO_NAME_MAX = 40;

/** The name the card starts with: the profile name, trimmed to fit. */
export function helloName(profileName: string | undefined): string {
  return (profileName ?? "").replace(/\s+/g, " ").trim().slice(0, HELLO_NAME_MAX);
}

export async function sayHi(name: string, request: Request): Promise<HelloOutcome> {
  try {
    const { url } = await request("/api/onboarding/welcome", {
      method: "POST",
      body: JSON.stringify({ name: helloName(name) }),
      timeoutMs: 20_000,
    });
    return typeof url === "string" && url.startsWith("https://") ? { kind: "open", url } : { kind: "hide" };
  } catch (cause) {
    if ((cause as { status?: unknown })?.status === 429) {
      return { kind: "later", message: "Too many hellos right now. Try again in a little while." };
    }
    return { kind: "hide" };
  }
}

/** The desktop app opens the chat in its own window; a browser gets a tab. */
export async function openHello(url: string): Promise<boolean> {
  try {
    if (window.ogb?.openWelcomeChat) return await window.ogb.openWelcomeChat(url);
    return window.open(url, "_blank", "noopener") !== null;
  } catch {
    return false;
  }
}
