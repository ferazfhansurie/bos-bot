// Capture against the serialized shapes WhatsApp Web actually hands
// whatsapp-web.js. The "current" fixtures are the 2026-10-03 live shape
// (digits replaced): the key has no `_serialized`, only its parts plus a
// minified copy, and every message was being dropped.
import { describe, expect, it } from "vitest";

import { captureFields, serializedMessageId, serializedWid } from "./whatsapp-capture.ts";

const currentDirect = {
  id: { fromMe: false, remote: "111111111111111@lid", id: "3EB0AAAA", $1: "false_111111111111111@lid_3EB0AAAA" },
  from: "111111111111111@lid",
  to: "222222222222@c.us",
  author: null,
  fromMe: false,
  timestamp: 1_790_972_088,
  type: "chat",
  body: "hello",
  hasMedia: false,
};

const currentGroup = {
  id: {
    fromMe: false,
    remote: "120363000000000000@g.us",
    id: "AC00F000",
    participant: "333333333333333@lid",
    $1: "false_120363000000000000@g.us_AC00F000_333333333333333@lid",
  },
  from: "120363000000000000@g.us",
  to: "222222222222@c.us",
  author: "333333333333333@lid",
  fromMe: false,
  timestamp: 1_790_972_100,
  type: "chat",
  body: "group hi",
  hasMedia: false,
};

describe("serializedMessageId", () => {
  it("rebuilds a direct-chat id when _serialized is gone", () => {
    expect(serializedMessageId(currentDirect.id)).toBe("false_111111111111111@lid_3EB0AAAA");
  });

  it("rebuilds a group id with its participant", () => {
    expect(serializedMessageId(currentGroup.id)).toBe("false_120363000000000000@g.us_AC00F000_333333333333333@lid");
  });

  it("matches the minified copy WhatsApp Web carries, for both live shapes", () => {
    for (const fixture of [currentDirect, currentGroup]) expect(serializedMessageId(fixture.id)).toBe(fixture.id.$1);
  });

  it("prefers _serialized when it is there", () => {
    expect(serializedMessageId({ _serialized: "true_1@c.us_X", fromMe: false, remote: "2@c.us", id: "Y" })).toBe("true_1@c.us_X");
  });

  it("reads remote and participant as Wid objects too", () => {
    expect(serializedMessageId({ fromMe: true, remote: { user: "1", server: "c.us" }, id: "Z" })).toBe("true_1@c.us_Z");
    expect(serializedMessageId({ fromMe: true, remote: { _serialized: "9@g.us" }, id: "Z", participant: { _serialized: "8@lid" } })).toBe("true_9@g.us_Z_8@lid");
  });

  it("gives up rather than invent an id", () => {
    expect(serializedMessageId(undefined)).toBeNull();
    expect(serializedMessageId({ remote: "1@c.us", id: "X" })).toBeNull();
    expect(serializedMessageId({ fromMe: false, id: "X" })).toBeNull();
    expect(serializedMessageId({ fromMe: false, remote: "1@c.us" })).toBeNull();
  });
});

describe("serializedWid", () => {
  it("handles strings, _serialized and user@server", () => {
    expect(serializedWid("1@c.us")).toBe("1@c.us");
    expect(serializedWid({ _serialized: "2@g.us" })).toBe("2@g.us");
    expect(serializedWid({ user: "3", server: "lid" })).toBe("3@lid");
    expect(serializedWid({})).toBeNull();
    expect(serializedWid("")).toBeNull();
  });
});

describe("captureFields", () => {
  it("captures a received message in today's shape", () => {
    const fields = captureFields(currentDirect);
    expect(fields.skip).toBeNull();
    if (fields.skip !== null) return;
    expect(fields.fallbackChatId).toBe("111111111111111@lid");
    expect(fields.message).toEqual({
      id: "false_111111111111111@lid_3EB0AAAA",
      from: "111111111111111@lid",
      author: null,
      fromMe: false,
      timestamp: 1_790_972_088,
      type: "chat",
      body: "hello",
      hasMedia: false,
    });
  });

  it("captures a sent message under the chat it went to", () => {
    const fields = captureFields({
      ...currentDirect,
      id: { fromMe: true, remote: "444444444444444@lid", id: "3EB0BBBB" },
      from: "222222222222@c.us",
      to: "444444444444444@lid",
      fromMe: true,
    });
    expect(fields.skip).toBeNull();
    if (fields.skip !== null) return;
    expect(fields.message.id).toBe("true_444444444444444@lid_3EB0BBBB");
    expect(fields.fallbackChatId).toBe("444444444444444@lid");
  });

  it("captures a group message with its author", () => {
    const fields = captureFields(currentGroup);
    expect(fields.skip).toBeNull();
    if (fields.skip !== null) return;
    expect(fields.message.author).toBe("333333333333333@lid");
    expect(fields.fallbackChatId).toBe("120363000000000000@g.us");
  });

  it("skips status updates quietly", () => {
    expect(captureFields({ ...currentDirect, from: "status@broadcast" })).toEqual({ skip: "status update", expected: true });
  });

  it("reports an unreadable id or chat as an unexpected drop", () => {
    expect(captureFields({ ...currentDirect, id: { $1: "minified only" } })).toEqual({ skip: "the message has no readable id", expected: false });
    expect(captureFields({ ...currentDirect, from: undefined })).toEqual({ skip: "the message has no readable chat id", expected: false });
  });
});
