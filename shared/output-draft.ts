/** Human working copy. Never replaces the provider's original message text. */
export interface OutputComment {
  id: string;
  version: number;
  start: number;
  end: number;
  quote: string;
  text: string;
}
export interface OutputDraft {
  revision: number;
  versions: string[];
  comments: OutputComment[];
}
export const OUTPUT_MAX_LENGTH = 100_000;

export function validateOutputDraft(input: unknown, original: string, previous?: OutputDraft): OutputDraft {
  const value = input as OutputDraft;
  if (!value || !Number.isInteger(value.revision) || value.revision !== (previous?.revision ?? 0)) throw new Error("draft changed elsewhere; reopen it before saving");
  if (!Array.isArray(value.versions) || value.versions.length < 1 || value.versions.length > 30 || value.versions.some(text => typeof text !== "string" || text.length > OUTPUT_MAX_LENGTH)) throw new Error("save up to 30 versions of 100,000 characters each");
  const baseline = previous?.versions ?? [original];
  if (baseline.some((text, i) => value.versions[i] !== text) || value.versions.length > baseline.length + 1) throw new Error("saved versions cannot be overwritten");
  if (!Array.isArray(value.comments) || value.comments.length > 100) throw new Error("save up to 100 comments");
  const ids = new Set<string>();
  let quoted = 0;
  for (const c of value.comments) {
    if (!c || typeof c.id !== "string" || !/^[\w-]{1,80}$/.test(c.id) || ids.has(c.id) || !Number.isInteger(c.version) || !Number.isInteger(c.start) || !Number.isInteger(c.end) || c.start < 0 || c.end <= c.start || c.version < 0 || c.version >= value.versions.length || c.end > value.versions[c.version].length || value.versions[c.version].slice(c.start, c.end) !== c.quote || typeof c.text !== "string" || !c.text.trim() || c.text.length > 4000) throw new Error("comments must reference exact text in a saved version");
    quoted += c.quote.length;
    if (quoted > OUTPUT_MAX_LENGTH) throw new Error("comments can quote up to 100,000 characters in total");
    ids.add(c.id);
  }
  return { revision: value.revision + 1, versions: [...value.versions], comments: value.comments.map(c => ({ id: c.id, version: c.version, start: c.start, end: c.end, quote: c.quote, text: c.text })) };
}

export function outputRevisionRequest(messageId: string, draft: OutputDraft, version: number): string {
  const comments = draft.comments.map((c, i) => `${i + 1}. version ${c.version + 1}, characters ${c.start + 1}–${c.end}: ${JSON.stringify(c.quote)}\ncomment: ${c.text}`).join("\n\n");
  return `revise this output from message ${messageId}. use working version ${version + 1} below and address the comments. return the revised output.\n\n<working-output>\n${draft.versions[version]}\n</working-output>\n\n<review-comments>\n${comments}\n</review-comments>`;
}
