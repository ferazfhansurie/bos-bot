import { describe, expect, it } from "vitest";
import { emptySharedHistory, mergeSharedHistory, sharedReadSequenceToSave, sharedRoomUnread, sharedAttachmentError, isDirectSharedRoom, sharedBotTargets, sharedMentionBots, type SharedMessage } from "./shared-conversation";

describe("shared conversations", () => {
  it("keeps explicit two-person groups separate from direct chats", () => {
    expect(isDirectSharedRoom({ kind: "group", memberIds: ["me", "you"] })).toBe(false);
    expect(isDirectSharedRoom({ kind: "direct", memberIds: ["me", "you"] })).toBe(true);
    expect(isDirectSharedRoom({ memberIds: ["me", "you"] })).toBe(true);
    expect(isDirectSharedRoom({ memberIds: ["me", "you", "them"] })).toBe(false);
  });

  const roster = [
    { id: "home:bot:one", name: "Koda", ownerName: "Firaz" },
    { id: "away:bot:two", name: "Koda", ownerName: "Faeez" },
    { id: "home:bot:three", name: "Scout", ownerName: "Firaz" },
  ];

  it("qualifies colliding bot names with their owner and targets the selected identity", () => {
    const choices = sharedMentionBots(roster);
    expect(choices.map(bot => bot.name)).toEqual(["Koda · Firaz", "Koda · Faeez", "Scout"]);
    expect(sharedBotTargets("@Koda · Faeez compare this with @Scout", choices)).toEqual(["away:bot:two", "home:bot:three"]);
    expect(sharedBotTargets("@Koda help", choices)).toEqual([]);
    expect(sharedBotTargets("@unavailable help", choices)).toEqual([]);
  });

  it("ignores mentions in quotes, code, links and longer names", () => {
    const choices = sharedMentionBots(roster);
    expect(sharedBotTargets('> @Scout\n\n`@Scout`\n\n```\n@Scout\n```\n\n[@Scout](https://example.com)\n\n@Scout-more @Scoutish', choices)).toEqual([]);
    expect(sharedBotTargets("(@Scout), @scout", choices)).toEqual(["home:bot:three"]);
    expect(sharedBotTargets('"@Scout" and “@Scout” and \\@Scout', choices)).toEqual([]);
  });
});

describe("shared messenger state", () => {
  it("applies the server image and file limits before upload", () => {
    expect(sharedAttachmentError({ name: "photo.png", type: "image/png", size: 10 * 1024 * 1024 })).toBeNull();
    expect(sharedAttachmentError({ name: "photo.png", type: "image/png", size: 10 * 1024 * 1024 + 1 })).toContain("10 MB");
    expect(sharedAttachmentError({ name: "notes.pdf", type: "application/pdf", size: 25 * 1024 * 1024 })).toBeNull();
    expect(sharedAttachmentError({ name: "notes.pdf", type: "application/pdf", size: 25 * 1024 * 1024 + 1 })).toContain("25 MB");
  });
  const message = (sequence: number, patch: Partial<SharedMessage> = {}): SharedMessage => ({
    id: `message-${sequence}`, sequence, sendId: `send-${sequence}`,
    actor: { homeId: "home", kind: "person", localId: "owner" }, text: `message ${sequence}`, at: sequence, ...patch,
  });

  it("merges edits into loaded rows without importing unloaded changes or moving the append cursor", () => {
    const loaded = mergeSharedHistory(emptySharedHistory(), { messages: [message(9), message(10)], version: 2, hasMore: true }, "latest");
    const edited = mergeSharedHistory(loaded, { messages: [], changes: [message(1, { text: "older edit", changeSequence: 3 }), message(9, { text: "updated", editedAt: 50, changeSequence: 4 })], version: 4 }, "after");
    expect(edited.messages.map(row => row.id)).toEqual(["message-9", "message-10"]);
    expect(edited.messages[0].text).toBe("updated");
    expect(edited.messages[1]).toBe(loaded.messages[1]);
    expect(edited).toMatchObject({ sequence: 10, version: 4, hasMore: true, changeRevision: 1 });
  });

  it("does not skip pending edits when older pages or mutation responses include newer versions", () => {
    const loaded = mergeSharedHistory(emptySharedHistory(), { messages: [message(9)], version: 2 }, "latest");
    const older = mergeSharedHistory(loaded, { messages: [message(8)], version: 20, hasMore: true }, "before");
    expect(older.version).toBe(2);
    expect(older.sequence).toBe(9);
    const removed = mergeSharedHistory(older, { messages: [message(9, { text: "", deletedAt: 100, changeSequence: 21 })], version: 21 }, "mutation");
    expect(removed.version).toBe(2);
    expect(removed.messages[1].deletedAt).toBe(100);
    const stalePoll = mergeSharedHistory(removed, { messages: [message(9)], version: 19 }, "after");
    expect(stalePoll.messages[1].deletedAt).toBe(100);
    expect(stalePoll.changeRevision).toBe(removed.changeRevision);
  });

  it("keeps reply references and tombstones in chronological position", () => {
    let history = mergeSharedHistory(emptySharedHistory(), { messages: [message(2, { replyTo: "message-1" }), message(1)], version: 0 }, "latest");
    history = mergeSharedHistory(history, { messages: [], changes: [message(1, { text: "", deletedAt: 30, changeSequence: 1 })], version: 1 }, "after");
    expect(history.messages.map(row => row.id)).toEqual(["message-1", "message-2"]);
    expect(history.messages[1].replyTo).toBe("message-1");
  });

  it("replays changes when scrollback arrives from before a concurrent edit", () => {
    const loaded = mergeSharedHistory(emptySharedHistory(), { messages: [message(9)], version: 2 }, "latest");
    const polled = mergeSharedHistory(loaded, { messages: [], changes: [message(8, { text: "edited while loading", changeSequence: 3 })], version: 3 }, "after");
    expect(polled.messages).toHaveLength(1);
    const oldPage = mergeSharedHistory(polled, { messages: [message(8)], version: 2 }, "before");
    expect(oldPage.version).toBe(2);
    const replayed = mergeSharedHistory(oldPage, { messages: [], changes: [message(8, { text: "edited while loading", changeSequence: 3 })], version: 3 }, "after");
    expect(replayed.messages[0].text).toBe("edited while loading");
  });

  it("marks only newer foreground-visible messages as read", () => {
    expect(sharedReadSequenceToSave(10, 8, true, true)).toBe(10);
    expect(sharedReadSequenceToSave(10, 8, false, true)).toBeNull();
    expect(sharedReadSequenceToSave(10, 8, true, false)).toBeNull();
    expect(sharedReadSequenceToSave(10, 10, true, true)).toBeNull();
    expect(sharedReadSequenceToSave(8, 10, true, true)).toBeNull();
  });

  it("uses server unread counts even when legacy local seen timestamps disagree", () => {
    expect(sharedRoomUnread({ unreadCount: 3, lastActivity: 1 }, 100)).toBe(true);
    expect(sharedRoomUnread({ unreadCount: 0, lastActivity: 100 }, 1)).toBe(false);
    expect(sharedRoomUnread({ lastActivity: 100 }, 1)).toBe(true);
  });
});
