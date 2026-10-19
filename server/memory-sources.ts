import { redactSecretsInText } from "./redact.ts";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { readMemoryDoc, MemoryStoreError } from "./memory-store.ts";
import { journalMemoryWrite } from "./memory-journal.ts";
import { DATA_DIR } from "./config.ts";
import { memorySourceIds } from "../shared/memory-source.ts";

export interface MemorySource {
  id: string; threadId: string; path: string; hash: string; text: string; line: number; at: number;
}
const file = (botId: string) => {
  if (!/^[\w-]{1,128}$/.test(botId)) throw new MemoryStoreError("path", 400, "invalid bot id");
  return join(DATA_DIR, "memory-sources", `${botId}.json`);
};
function load(botId: string): MemorySource[] {
  try {
    const path = file(botId);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3_000_000) return [];
    const rows: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(rows) ? rows.filter((row): row is MemorySource => row && typeof row.id === "string" && typeof row.threadId === "string" && typeof row.path === "string" && typeof row.hash === "string" && typeof row.text === "string" && Number.isInteger(row.line) && typeof row.at === "number") : [];
  } catch { return []; }
}
/** Record exact on-disk lines, never the FTS snippet's bracket formatting.
 * This is scoped to the retrieving bot and conversation and bounded on disk. */
export function recordRetrievedMemory(botId: string, threadId: string, path: string, query: string): MemorySource | undefined {
  const doc = readMemoryDoc(botId, path);
  const words = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!doc.exists || !words.length) return undefined;
  const lines = doc.text.split("\n");
  const scores = lines.map(line => words.filter(word => line.toLowerCase().includes(word)).length);
  const best = Math.max(...scores);
  if (!best) return undefined;
  const line = scores.indexOf(best);
  if (!lines[line].trim() || lines[line].length > 4000 || redactSecretsInText(lines[line]) !== lines[line]) return undefined;
  const source: MemorySource = { id: randomUUID(), threadId, path, hash: doc.hash, text: lines[line], line: line + 1, at: Date.now() };
  const existing = load(botId).filter(row => row.at > Date.now() - 30 * 86_400_000).slice(-499);
  mkdirSync(join(DATA_DIR, "memory-sources"), { recursive: true, mode: 0o700 });
  writeFileAtomic(file(botId), JSON.stringify([...existing, source]), { mode: 0o600 });
  return source;
}
export function answerMemorySources(botId: string, threadId: string, answer: { role: string; text?: string }): MemorySource[] {
  if (answer.role !== "bot") return [];
  const ids = memorySourceIds(answer.text ?? "");
  return load(botId).filter(row => row.threadId === threadId && ids.includes(row.id) && row.at > Date.now() - 30 * 86_400_000);
}
export function correctAnswerMemory(botId: string, threadId: string, answer: { role: string; text?: string }, sourceId: string, expectedHash: string, replacement: string) {
  const source = answerMemorySources(botId, threadId, answer).find(row => row.id === sourceId);
  if (!source) throw new MemoryStoreError("forbidden", 404, "this answer has no such memory source");
  const doc = readMemoryDoc(botId, source.path);
  if (expectedHash !== source.hash || doc.hash !== source.hash) throw new MemoryStoreError("conflict", 409, "memory changed since this source was retrieved; review it in memory settings");
  const lines = doc.text.split("\n");
  if (lines[source.line - 1] !== source.text) throw new MemoryStoreError("conflict", 409, "the original memory entry changed");
  if (replacement.includes("\n") || replacement.includes("\r") || replacement.length > 4000) throw new MemoryStoreError("forbidden", 400, "use one memory entry of at most 4000 characters");
  if (replacement.trim()) lines[source.line - 1] = replacement;
  else lines.splice(source.line - 1, 1);
  return journalMemoryWrite(botId, source.path, lines.join("\n"), { actor: "person", via: "answer-source", threadId, expectedHash });
}
