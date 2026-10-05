/** Attachments are embedded in queued text; editing cannot change file authority. */
export function assertQueueAttachmentsUnchanged(before: string, after: string): void {
  const tags = (text: string) => text.match(/<attached-(?:image|file)\b[^>]*\/?>/g) ?? [];
  if (JSON.stringify(tags(before)) !== JSON.stringify(tags(after))) {
    throw Object.assign(new Error("queued attachments must remain unchanged"), { status: 400 });
  }
}
