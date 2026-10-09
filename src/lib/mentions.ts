import { MAUS_COLORS, type MausColor } from "./mascot";
import { resolveMausColor } from "../../shared/glyph-faces";

export type MentionPeer = { name: string; hidden?: boolean; color?: MausColor };
export type MentionRange = { start: number; end: number; color?: string };

/** Filter the composer's mention roster without silently truncating it.
 * Large rooms stay fully reachable; the picker itself owns scrolling. */
export function mentionChoicesForQuery<T extends { name: string; searchText?: string }>(pool: readonly T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  // "@Scout " is a completed tag, not a new search. Closing here lets Enter
  // send instead of selecting the same bot again.
  if (query.endsWith(" ") && pool.some((choice) => choice.name.toLowerCase() === normalized)) return [];
  if (!normalized) return [...pool];
  // A few typed letters almost always mean the start of a name, so rank
  // prefix > word start > anywhere in the name > owner/title. Input order
  // holds within a tier; the caller's order (everyone first, room order) means something.
  const tiers: T[][] = [[], [], [], []];
  for (const choice of pool) {
    const tier = mentionTier(choice, normalized);
    if (tier !== -1) tiers[tier].push(choice);
  }
  return tiers.flat();
}

function mentionTier(choice: { name: string; searchText?: string }, normalized: string): number {
  const name = choice.name.toLowerCase();
  if (name.startsWith(normalized)) return 0;
  if (name.split(/[\s._-]+/).some((word) => word.startsWith(normalized))) return 1;
  if (name.includes(normalized)) return 2;
  return choice.searchText?.toLowerCase().includes(normalized) ? 3 : -1;
}

/** Where the typed query sits in a picker row's name, for highlighting.
 * Prefers a word start over an earlier mid-word hit. */
export function mentionMatchRange(name: string, query: string): { start: number; end: number } | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const lower = name.toLowerCase();
  let at = lower.indexOf(normalized);
  if (at === -1) return null;
  for (let i = at; i !== -1; i = lower.indexOf(normalized, i + 1)) {
    if (i === 0 || /[\s._-]/.test(lower[i - 1])) { at = i; break; }
  }
  return { start: at, end: at + normalized.length };
}

/** Display word-start, longest-name matches without coloring Unicode prefixes.
 * Keep offsets in the original string so casing and Unicode remain intact. */
export function mentionRanges(text: string, peers: readonly MentionPeer[], everyone = false): MentionRange[] {
  const candidates = peers.filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (at > 0 && !/\s/.test(text[at - 1])) continue;
    const rest = text.slice(at + 1);
    const peer = candidates.find(({ name }) => rest.slice(0, name.length).toLowerCase() === name.toLowerCase()
      && !/^[\p{L}\p{N}\p{M}_]/u.test(rest.slice(name.length)));
    const all = everyone && /^everyone(?![\p{L}\p{N}\p{M}_])/iu.test(rest);
    const length = all ? 8 : peer?.name.length;
    if (length === undefined) continue;
    // Only palette names and plain #RRGGBB enter CSS. @everyone has no individual bot identity.
    const color = !all && peer?.color && (Object.hasOwn(MAUS_COLORS, peer.color) || /^#[0-9A-Fa-f]{6}$/.test(peer.color)) ? resolveMausColor(peer.color) : undefined;
    ranges.push({ start: at, end: at + length + 1, ...(color ? { color } : {}) });
    at += length;
  }
  return ranges;
}

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: { className: string; style?: string } };
};

/** Transform text nodes only: links, code and image metadata stay untouched. */
export function remarkMentions({ peers, everyone = false }: { peers: readonly MentionPeer[]; everyone?: boolean }) {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (!node.children || ["link", "linkReference", "code", "inlineCode"].includes(node.type)) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value) { visit(child); return [child]; }
        const text = child.value;
        const ranges = mentionRanges(text, peers, everyone);
        if (!ranges.length) return [child];
        const result: MarkdownNode[] = [];
        let end = 0;
        for (const range of ranges) {
          if (range.start > end) result.push({ type: "text", value: text.slice(end, range.start) });
          result.push({ type: "mention", data: { hName: "span", hProperties: {
            className: "mention-highlight",
            ...(range.color ? { style: `--mention-color:${range.color}` } : {}),
          } },
            children: [{ type: "text", value: text.slice(range.start, range.end) }] });
          end = range.end;
        }
        if (end < text.length) result.push({ type: "text", value: text.slice(end) });
        return result;
      });
    };
    visit(tree);
  };
}
