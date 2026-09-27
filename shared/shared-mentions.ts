import { fromMarkdown } from "mdast-util-from-markdown";

export interface SharedMentionIdentity {
  id: string; name: string; kind: "person" | "bot"; ownerName?: string;
}

/** Only active prose can address someone. Quoted examples are inert. */
export function sharedMentionText(text: string): string {
  const parts: string[] = [];
  type Node = { type: string; value?: string; children?: Node[]; position?: { start: { offset?: number }; end: { offset?: number } } };
  const walk = (node: Node) => {
    if (["code", "inlineCode", "blockquote", "link", "image", "html"].includes(node.type)) return;
    if (node.type === "text") parts.push(node.position?.start.offset !== undefined && node.position.end.offset !== undefined
      ? text.slice(node.position.start.offset, node.position.end.offset) : node.value ?? "");
    else node.children?.forEach(walk);
  };
  walk(fromMarkdown(text) as Node);
  return parts.join("\n").replace(/"[^"\n]*"|“[^”\n]*”/g, "");
}

export function sharedMentionLabel(identity: SharedMentionIdentity, roster: readonly SharedMentionIdentity[]): string {
  const same = roster.filter(other => other.name.toLowerCase() === identity.name.toLowerCase());
  if (same.length < 2) return identity.name;
  const qualifier = (item: SharedMentionIdentity) => item.kind === "person" ? "person" : item.ownerName || "bot";
  const label = `${identity.name} · ${qualifier(identity)}`;
  // Very rare equal names and equal owner names still need an unambiguous,
  // order-independent choice. Never use roster position as identity.
  return same.filter(other => qualifier(other).toLowerCase() === qualifier(identity).toLowerCase()).length > 1
    ? `${label} · ${identity.id}` : label;
}

/** Resolve against people and bots together. The longest valid alias wins;
 * @Alex Lee cannot also mention Alex, and @Alex · person cannot invoke Alex. */
export function sharedMentionTargets(text: string, roster: readonly SharedMentionIdentity[]): string[] {
  const lower = sharedMentionText(text).toLowerCase();
  const aliases = roster.flatMap(identity => {
    const label = sharedMentionLabel(identity, roster);
    const labels = [label];
    if (label === identity.name) labels.push(`${identity.name} · ${identity.kind === "person" ? "person" : identity.ownerName || "bot"}`);
    return labels.map(name => ({ id: identity.id, alias: `@${name}`.toLowerCase() }));
  });
  const matches: { id: string; start: number; end: number }[] = [];
  for (const { id, alias } of aliases) {
    let start = lower.indexOf(alias);
    while (start >= 0) {
      const end = start + alias.length;
      if (!/[\p{L}\p{N}_@\\]/u.test(lower[start - 1] ?? " ") && !/[\p{L}\p{N}_-]/u.test(lower[end] ?? " ")
          && !/^\s+·(?:\s|$)/u.test(lower.slice(end))) matches.push({ id, start, end });
      start = lower.indexOf(alias, start + 1);
    }
  }
  const selected: typeof matches = [];
  for (const match of matches.sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (!selected.some(other => match.start < other.end && match.end > other.start)) selected.push(match);
  }
  const ids = new Set(selected.map(match => match.id));
  return roster.filter(identity => ids.has(identity.id)).map(identity => identity.id);
}
