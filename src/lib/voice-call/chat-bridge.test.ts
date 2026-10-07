import { describe, expect, it } from "vitest";

import type { Message } from "@/state/store";
import { capLandedText, landedReplies, recallMessages } from "./chat-bridge";

const msg = (m: Partial<Message> & { id: string }): Message =>
  ({ role: "bot", kind: "text", text: "x", at: 0, ...m }) as Message;

describe("recallMessages", () => {
  it("keeps the last written, sent messages, oldest first, from the bot's point of view", () => {
    const messages = [
      msg({ id: "1", role: "user", text: "old" }),
      msg({ id: "2", kind: "activity", text: "reading a file" }),
      msg({ id: "3", role: "user", text: "  queued  ", queued: true } as Partial<Message> & { id: string }),
      msg({ id: "4", text: "   " }),
      msg({ id: "5", role: "user", text: " check stock " }),
      msg({ id: "6", text: "done" }),
    ];
    expect(recallMessages(messages)).toEqual([
      { who: "them", text: "old" },
      { who: "them", text: "check stock" },
      { who: "you", text: "done" },
    ]);
    expect(recallMessages(messages, 2)).toEqual([
      { who: "them", text: "check stock" },
      { who: "you", text: "done" },
    ]);
  });

  it("caps at 30 by default", () => {
    const many = Array.from({ length: 40 }, (_, i) => msg({ id: String(i), text: `m${i}` }));
    const recalled = recallMessages(many);
    expect(recalled).toHaveLength(30);
    expect(recalled[0].text).toBe("m10");
  });
});

describe("landedReplies", () => {
  const messages = [
    msg({ id: "before", at: 10, text: "old answer" }),
    msg({ id: "user", role: "user", at: 20, text: "do it" }),
    msg({ id: "tool", kind: "activity", at: 21 }),
    msg({ id: "draft", at: 22, text: "working on it" }),
    msg({ id: "final", at: 23, text: "done", turnTerminal: true } as Partial<Message> & { id: string }),
  ];

  it("waits for a settled turn while the bot is busy", () => {
    expect(landedReplies({ messages, sinceAt: 20, busy: true, delivered: new Set() }).map((m) => m.id)).toEqual(["final"]);
  });

  it("takes every new bot text once the bot is idle, minus delivered ones", () => {
    expect(landedReplies({ messages, sinceAt: 20, busy: false, delivered: new Set(["draft"]) }).map((m) => m.id)).toEqual(["final"]);
    expect(landedReplies({ messages, sinceAt: 20, busy: false, delivered: new Set() }).map((m) => m.id)).toEqual(["draft", "final"]);
  });
});

describe("capLandedText", () => {
  it("trims and caps at 2000 chars with an ellipsis", () => {
    expect(capLandedText("  short  ")).toBe("short");
    const capped = capLandedText("a".repeat(2500));
    expect(capped).toHaveLength(2000);
    expect(capped.endsWith("…")).toBe(true);
  });
});
