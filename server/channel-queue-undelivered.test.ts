import { afterEach, describe, expect, it, vi } from "vitest";

import * as journal from "./message-db.ts";
import {
  drainChannelMessages,
  noteUndeliveredChannelMessage,
  queueChannelMessage,
  restoreChannelMessages,
  undeliveredChannelMessageNotice,
} from "./channel-queue.ts";

afterEach(() => {
  journal.settleChatFollowups(journal.chatFollowups().map((row) => row.id), null);
  restoreChannelMessages();
});

describe("queued channel message sender (B14)", () => {
  it("hands the human sender to the drain", () => {
    queueChannelMessage("group-s", "thread-s", "from a teammate", { sender: { name: "ana@example.com" } });
    queueChannelMessage("group-s", "thread-s", "from the owner");
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    drainChannelMessages(() => false, run);
    expect(run.mock.calls[0][0]).toMatchObject({ text: "from a teammate", sender: { name: "ana@example.com" } });
    expect(run.mock.calls[1][0].sender).toBeUndefined();
  });

  it("persists the sender across a restart", () => {
    const queued = queueChannelMessage("group-r", "thread-r", "survive restart", { sender: { name: "Ana's phone" } });
    journal.closeMessageDb();
    restoreChannelMessages();
    const run = vi.fn();
    drainChannelMessages(() => false, run);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0][0]).toMatchObject({ id: queued.id, text: "survive restart", sender: { name: "Ana's phone" } });
  });
});

describe("undelivered queued channel message (B15)", () => {
  it("quotes a flattened, bounded snippet", () => {
    expect(undeliveredChannelMessageNotice("  short\n\nnote ")).toBe(
      'queued message not delivered — this room no longer owns the task: "short note"',
    );
    const notice = undeliveredChannelMessageNotice("x".repeat(500));
    expect(notice).toContain(`"${"x".repeat(79)}…"`);
    expect(notice.length).toBeLessThan(200);
  });

  it("leaves a visible row in a thread that still exists", () => {
    const appended: Array<{ threadId: string; message: unknown }> = [];
    const log = vi.fn();
    const result = noteUndeliveredChannelMessage(
      {
        messagesFor: () => [{ id: "earlier" }],
        appendMessage: (threadId, message) => appended.push({ threadId, message }),
      },
      { groupId: "g", threadId: "t", id: "q", text: "please ship it" },
      log,
    );
    expect(result).toBe("noted");
    expect(log).not.toHaveBeenCalled();
    expect(appended).toEqual([{
      threadId: "t",
      message: {
        role: "bot",
        kind: "activity",
        tool: { name: 'queued message not delivered — this room no longer owns the task: "please ship it"', ok: false },
      },
    }]);
  });

  it("logs instead of resurrecting a deleted thread", () => {
    const appendMessage = vi.fn();
    const log = vi.fn();
    const result = noteUndeliveredChannelMessage(
      { messagesFor: () => [], appendMessage },
      { groupId: "g", threadId: "gone", id: "q", text: "lost words" },
      log,
    );
    expect(result).toBe("logged");
    expect(appendMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain('"lost words"');
    expect(log.mock.calls[0][0]).toContain("thread gone");
  });
});
