import { expect, it } from "vitest";
import { journalMemoryWrite, flushMemoryJournal, readMemoryJournal } from "./memory-journal.ts";
import { answerMemorySources, correctAnswerMemory, recordRetrievedMemory } from "./memory-sources.ts";
import { readMemoryDoc } from "./memory-store.ts";

it("attributes only explicit exact-answer markers and guards exact-entry corrections", async () => {
  journalMemoryWrite("source-bot", "MEMORY.md", "- coffee: black\n- tea: green\n", { actor: "person", via: "test" });
  const source = recordRetrievedMemory("source-bot", "thread-a", "MEMORY.md", "coffee")!;
  expect(source.text).toBe("- coffee: black");
  const answer = { role: "bot", text: `black coffee [memory-source:${source.id}]` };
  expect(answerMemorySources("source-bot", "thread-a", { role: "bot", text: "no explicit citation" })).toEqual([]);
  expect(answerMemorySources("source-bot", "thread-b", answer)).toEqual([]);
  expect(answerMemorySources("other-bot", "thread-a", answer)).toEqual([]);
  expect(answerMemorySources("source-bot", "thread-a", { ...answer, role: "user" })).toEqual([]);
  expect(answerMemorySources("source-bot", "thread-a", answer)).toEqual([source]);
  expect(() => correctAnswerMemory("source-bot", "thread-a", answer, source.id, "wrong", "- coffee: oat milk")).toThrow("memory changed");
  correctAnswerMemory("source-bot", "thread-a", answer, source.id, source.hash, "- coffee: oat milk");
  expect(readMemoryDoc("source-bot", "MEMORY.md").text).toBe("- coffee: oat milk\n- tea: green\n");
  expect(() => correctAnswerMemory("source-bot", "thread-a", answer, source.id, source.hash, "")).toThrow("memory changed");
  const updated = recordRetrievedMemory("source-bot", "thread-a", "MEMORY.md", "coffee")!;
  correctAnswerMemory("source-bot", "thread-a", { role: "bot", text: `[memory-source:${updated.id}]` }, updated.id, updated.hash, "");
  expect(readMemoryDoc("source-bot", "MEMORY.md").text).toBe("- tea: green\n");
  await flushMemoryJournal("source-bot");
  expect(readMemoryJournal("source-bot").filter(row => row.via === "answer-source")).toHaveLength(2);
});
