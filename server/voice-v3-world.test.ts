import { describe, expect, it } from "vitest";

import type { InboxItem } from "../shared/wire.ts";
import type { Store } from "./store.ts";
import { createVoiceWorld, type VoiceWorldDeps } from "./voice-v3-world.ts";

function question(over: Partial<InboxItem> = {}): InboxItem {
  return { id: "i1", kind: "question", botId: "b-bos", threadId: "t1", title: "which plan", preview: "a or b?", at: 1, messageId: "m1", requestId: "r1", options: ["a", "b"], ...over } as InboxItem;
}

function world(over: Partial<VoiceWorldDeps> & { items?: InboxItem[] } = {}) {
  const answered: string[] = [];
  const store = {
    bots: [{ id: "b-bos", name: "bos" }],
    bot: (id: string) => (id === "b-bos" ? { id, name: "bos" } : undefined),
    tasks: () => [],
    messagesFor: () => [],
    taskByThread: () => undefined,
    createTask: () => ({ threadId: "t-new" }),
  } as unknown as Store;
  const deps: VoiceWorldDeps = {
    store,
    userName: () => "Firaz",
    threadState: () => "idle",
    inbox: () => ({ items: over.items ?? [question()] }),
    routineRuns: () => [],
    routines: () => [],
    calendarCalls: () => [],
    readMemory: () => "",
    readMemoryDoc: () => ({ text: "", hash: "h0" }),
    memoryTopics: () => [],
    writeMemory: () => {},
    assertBudget: () => {},
    send: async () => {},
    accepted: () => false,
    deleteThread: () => {},
    botChanged: () => {},
    answer: async (_item, answer) => { answered.push(answer); return true; },
    ...over,
  };
  return { w: createVoiceWorld(deps, "Asia/Kuala_Lumpur"), answered };
}

describe("voice world", () => {
  it("answers only the same plain question that was read out", async () => {
    const read = world().w.needsMe()[0];
    expect(read.approval).toBe(false);
    // a new ask took the card's place
    const replaced = world({ items: [question({ requestId: "r2" })] });
    expect(await replaced.w.answerQuestion(read, "a")).toBe(false);
    expect(replaced.answered).toEqual([]);
    // the same card turned into an approval
    const approval = world({ items: [question({ approval: true })] });
    expect(await approval.w.answerQuestion(read, "a")).toBe(false);
    // a bare yes/no ask with no options counts as an approval
    const bare = world({ items: [question({ options: undefined })] });
    expect(bare.w.needsMe()[0].approval).toBe(true);
    expect(await bare.w.answerQuestion(read, "a")).toBe(false);
    const same = world();
    expect(await same.w.answerQuestion(read, "a")).toBe(true);
    expect(same.answered).toEqual(["a"]);
  });

  it("a memory note written while a bot changed the doc is redone on the new text", () => {
    let text = "old";
    let hash = "h1";
    let writes = 0;
    const { w } = world({
      readMemoryDoc: () => ({ text, hash }),
      writeMemory: (_bot, _path, next, expected) => {
        writes += 1;
        // the bot wrote between our read and our write
        if (writes === 1) { text = "old + bot line"; hash = "h2"; }
        if (expected !== hash) throw new Error("hash mismatch");
        text = next;
      },
    });
    w.writeMemory("b-bos", "memory/voice.md", (before) => `${before}\ncall note`);
    expect(text).toBe("old + bot line\ncall note");
    expect(writes).toBe(2);
  });

  it("a failed first send deletes the thread it opened; one that landed keeps it", async () => {
    const deleted: string[] = [];
    const opened: string[] = [];
    const refused = world({ send: async () => { throw new Error("busy"); }, deleteThread: (_b, t) => { deleted.push(t); } });
    await expect(refused.w.startJob({ botId: "b-bos", title: "x", text: "x", callId: "call-00000001", sendId: "voicejob-a", opened: (t) => opened.push(t) })).rejects.toThrow("busy");
    expect(opened).toEqual(["t-new"]);
    expect(deleted).toEqual(["t-new"]);
    const landed = world({ send: async () => { throw new Error("reset"); }, accepted: () => true, deleteThread: (_b, t) => { deleted.push(t); } });
    await expect(landed.w.startJob({ botId: "b-bos", title: "x", text: "x", callId: "call-00000001", sendId: "voicejob-b" })).rejects.toThrow("reset");
    expect(deleted).toEqual(["t-new"]);
  });
  it("every call card lands in one calls thread; old card-only threads fold in and archive", () => {
    type T = { threadId: string; title: string; createdAt: number; voiceCalls?: true; archivedAt?: number; unread?: boolean; lastActivityAt?: number; busy?: boolean };
    const card = (seconds: number) => ({ seconds, summary: `call ${seconds}`, jobs: [] }) as never;
    const tasks: T[] = [
      { threadId: "old-2", title: "voice chat", createdAt: 20 },
      { threadId: "talk", title: "voice chat", createdAt: 15 },
      { threadId: "old-1", title: "voice chat", createdAt: 10 },
    ];
    const messages: Record<string, Array<Record<string, unknown>>> = {
      "old-1": [{ id: "a", at: 10, role: "bot", kind: "text", text: "first", voiceCall: card(1) }],
      "old-2": [{ id: "b", at: 20, role: "bot", kind: "text", text: "second", voiceCall: card(2) }],
      // the person replied under this card: a real conversation, left alone
      talk: [{ id: "c", at: 15, role: "bot", kind: "text", text: "mid", voiceCall: card(3) }, { id: "d", at: 16, role: "user", kind: "text", text: "do that" }],
    };
    let n = 0;
    const store = {
      bots: [{ id: "b-bos", name: "bos" }],
      bot: (id: string) => (id === "b-bos" ? { id, name: "bos" } : undefined),
      tasks: () => tasks,
      taskByThread: (_b: string, id: string) => tasks.find((task) => task.threadId === id),
      messagesFor: (id: string) => messages[id] ?? [],
      createTask: (_b: string, title: string) => { const task = { threadId: `calls-${++n}`, title, createdAt: 30 }; tasks.unshift(task); return task; },
      patchTask: (_b: string, id: string, patch: Partial<T>) => { const task = tasks.find((row) => row.threadId === id)!; Object.assign(task, patch); return task; },
      appendMessage: (id: string, message: Record<string, unknown>) => { const full = { id: `m${++n}`, at: 99, ...message }; (messages[id] ??= []).push(full); return full; },
      patchMessage: () => {},
    } as unknown as Store;
    const { w } = world({ store });
    const first = w.postCard("b-bos", card(60), "now");
    expect(first.threadId).toBe("calls-1");
    const calls = tasks.find((task) => task.threadId === "calls-1")!;
    expect(calls.voiceCalls).toBe(true);
    expect(calls.unread).toBe(true);
    // oldest first, with their own times, then the new card
    expect(messages["calls-1"].map((m) => m.text)).toEqual(["first", "second", "now"]);
    expect(messages["calls-1"].slice(0, 2).map((m) => m.at)).toEqual([10, 20]);
    expect(tasks.find((task) => task.threadId === "old-1")!.archivedAt).toBeTypeOf("number");
    expect(tasks.find((task) => task.threadId === "old-2")!.archivedAt).toBeTypeOf("number");
    expect(tasks.find((task) => task.threadId === "talk")!.archivedAt).toBeUndefined();
    // the next call reuses it, even after the person archived it
    calls.archivedAt = 5;
    const second = w.postCard("b-bos", card(30), "later");
    expect(second.threadId).toBe("calls-1");
    expect(tasks.filter((task) => task.voiceCalls)).toHaveLength(1);
    expect(messages["calls-1"].at(-1)!.text).toBe("later");
  });
});
