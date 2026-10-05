export type ToolKind = "home" | "terminal" | "browser";
/** The <webview> needs the desktop shell's webviewTag and attach guard, which
 * ship with the preload's partition. A shell older than 1.6 (kept by the
 * ordinary updater, which replaces only server and UI) renders the tag as an
 * inert element, so the Browser tool must explain instead of showing blank. */
export function browserSupported(bridge: { toolsBrowserPartition?: string } | undefined): boolean {
  return Boolean(bridge?.toolsBrowserPartition);
}
/** Explicit schemes are never turned into searches; only web URLs load. */
export function browserAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (text === "about:blank") return text;
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:\/|$)/.test(text)) {
    try { const url = new URL(text); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  if (!/\s/.test(text) && /^(?:localhost|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:[/?#]|$)/.test(text)) {
    try { return new URL(`https://${text}`).href; } catch { return null; }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}
