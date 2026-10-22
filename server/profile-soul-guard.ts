/** Optional compare-and-set envelope used by mobile profile edits. */
export function profileSoulEnvelope(body: unknown): { patch: unknown; expectedSoul?: string; error?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { patch: body };
  const { expectedSoul, ...patch } = body as Record<string, unknown>;
  if (expectedSoul !== undefined && (typeof expectedSoul !== "string" || Buffer.byteLength(expectedSoul, "utf8") > 24_000)) {
    return { patch, error: "expectedSoul must be standing instructions of at most 24000 bytes" };
  }
  if (expectedSoul !== undefined && typeof patch.soul !== "string") return { patch, error: "expectedSoul requires a soul edit" };
  return { patch, ...(typeof expectedSoul === "string" ? { expectedSoul } : {}) };
}

export function profileSoulConflict(expected: string | undefined, current: string | undefined): boolean {
  return expected !== undefined && expected !== (current ?? "");
}
