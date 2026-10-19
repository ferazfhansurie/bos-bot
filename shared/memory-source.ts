/** Only an explicit marker on an answer claims that answer used a source.
 * Retrieval alone never implies attribution. Server validation is required. */
export const MEMORY_SOURCE_MARKER = /\[memory-source:([a-f0-9-]{36})\]/g;
export function memorySourceIds(text: string): string[] {
  return [...new Set([...text.matchAll(MEMORY_SOURCE_MARKER)].map(match => match[1]))].slice(0, 12);
}

export function withoutMemorySourceMarkers(text: string): string {
  return text.replace(MEMORY_SOURCE_MARKER, "").trim();
}
