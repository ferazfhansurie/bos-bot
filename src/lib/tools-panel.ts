export type ToolKind = "home" | "files" | "terminal" | "browser" | "side-chat" | "page";
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
