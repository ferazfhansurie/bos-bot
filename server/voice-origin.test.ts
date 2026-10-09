// Voice v2, server side: what a send spoken on a live call carries, the one
// line the model is told, and the push the caller gets when the work settles.
// The wiring (HTTP send -> message -> turn -> settle) is pinned end to end in
// voice-origin.e2e.test.ts.
import { describe, expect, it } from "vitest";

import { buildApnsPayload } from "./apns-push.ts";
import { buildNotification, buildVoiceWorkDone, ownerPushTarget } from "./notify.ts";
import { parseMessageOrigin, turnVoiceOrigin, VOICE_CALL_HINT, withVoiceCallHint } from "./voice-origin.ts";

describe("parseMessageOrigin", () => {
  it("treats an absent origin as an ordinary send", () => {
    expect(parseMessageOrigin(undefined)).toEqual({ ok: true });
    expect(parseMessageOrigin(null)).toEqual({ ok: true });
  });

  it("accepts a voice call origin and keeps only its known fields", () => {
    expect(parseMessageOrigin({ kind: "voice_call", callId: "call-1", job: "check the inbox", extra: 1 }))
      .toEqual({ ok: true, origin: { kind: "voice_call", callId: "call-1", job: "check the inbox" } });
    // job is optional; an empty one is the same as none
    expect(parseMessageOrigin({ kind: "voice_call", callId: "c" })).toEqual({ ok: true, origin: { kind: "voice_call", callId: "c" } });
    expect(parseMessageOrigin({ kind: "voice_call", callId: "c", job: "  " })).toEqual({ ok: true, origin: { kind: "voice_call", callId: "c" } });
    expect(parseMessageOrigin({ kind: "voice_call", callId: "x".repeat(128), job: "j".repeat(2000) }).ok).toBe(true);
  });

  it.each([
    ["a string", "voice_call"],
    ["an array", [{ kind: "voice_call", callId: "c" }]],
    ["another kind", { kind: "composer", callId: "c" }],
    ["no callId", { kind: "voice_call" }],
    ["an empty callId", { kind: "voice_call", callId: " " }],
    ["a numeric callId", { kind: "voice_call", callId: 7 }],
    ["a callId over 128 chars", { kind: "voice_call", callId: "x".repeat(129) }],
    ["a job over 2000 chars", { kind: "voice_call", callId: "c", job: "j".repeat(2001) }],
    ["a non-string job", { kind: "voice_call", callId: "c", job: { text: "x" } }],
  ])("refuses %s", (_label, value) => {
    expect(parseMessageOrigin(value).ok).toBe(false);
  });
});

describe("the voice hint", () => {
  const origin = { kind: "voice_call" as const, callId: "call-1" };

  it("prefixes exactly one line, only for a voice turn", () => {
    expect(VOICE_CALL_HINT).toBe("sent from a live voice call: lead with the outcome in one or two plain spoken sentences, details after.");
    expect(withVoiceCallHint("how many bots are online", origin)).toBe(`${VOICE_CALL_HINT}\nhow many bots are online`);
    expect(withVoiceCallHint("how many bots are online", undefined)).toBe("how many bots are online");
  });

  it("finds the newest voice line among the lines a turn delivers", () => {
    const later = { kind: "voice_call" as const, callId: "call-2" };
    expect(turnVoiceOrigin([{}, undefined])).toBeUndefined();
    expect(turnVoiceOrigin([{ origin }, {}])).toEqual(origin);
    expect(turnVoiceOrigin([{ origin }, { origin: later }, {}])).toEqual(later);
  });
});

describe("the voice done push", () => {
  const quiet = { id: "bot-1", name: "bos", threadId: "thread-1", notifications: false };

  it("reaches the caller even when the bot's notifications are off", () => {
    expect(buildNotification("done", quiet, "thread-1", "3 bots are online")).toBeNull();
    expect(buildVoiceWorkDone(quiet, "thread-1", "3 bots are online.\n\nDetails: bos, api, mobile.", { callId: "call-1", messageId: "msg-9" }))
      .toEqual({
        kind: "voice_work_done",
        botId: "bot-1",
        botName: "bos",
        threadId: "thread-1",
        title: "bos is done",
        body: "3 bots are online. Details: bos, api, mobile.",
        callId: "call-1",
        messageId: "msg-9",
      });
  });

  it("summarizes a long reply and says so when the work stopped", () => {
    const long = buildVoiceWorkDone(quiet, "t", `${"word ".repeat(80)}\n\`\`\`\ncode\n\`\`\``, { callId: "c", messageId: "m" });
    expect(long.body.length).toBeLessThanOrEqual(140);
    expect(long.body).not.toContain("code");
    expect(buildVoiceWorkDone(quiet, "t", "", { callId: "c", messageId: "m" }).body).toBe("Finished.");
    expect(buildVoiceWorkDone(quiet, "t", "", { callId: "c", messageId: "m" }, { failure: "engine offline" }).body)
      .toBe("It stopped before finishing: engine offline");
    expect(buildVoiceWorkDone(quiet, "t", "", { callId: "c", messageId: "m" }, { failure: "" }).body).toBe("It stopped before finishing.");
    // the reply wins when the turn said something before it broke
    expect(buildVoiceWorkDone(quiet, "t", "half done", { callId: "c", messageId: "m" }, { failure: "x" }).body).toBe("half done");
  });

  it("puts the phone's data on the APNs payload", () => {
    const notification = buildVoiceWorkDone(quiet, "thread-1", "done", { callId: "call-1", messageId: "msg-9" });
    const payload = buildApnsPayload(notification.title, notification.body, ownerPushTarget(notification), "device-1");
    expect(payload).toMatchObject({
      aps: { alert: { title: "bos is done", body: "done" } },
      type: "voice_work_done",
      botId: "bot-1",
      threadId: "thread-1",
      callId: "call-1",
      messageId: "msg-9",
    });
  });

  it("leaves every other push's target as it was", () => {
    const done = buildNotification("done", { ...quiet, notifications: true }, "thread-1", "ok", { messageId: "m" })!;
    expect(ownerPushTarget(done)).toEqual({ kind: "done", botId: "bot-1", threadId: "thread-1", senderId: "bot:bot-1", senderName: "bos finished", messageId: "m" });
    expect(ownerPushTarget({ kind: "digest", botId: "", botName: "", threadId: "", title: "Today", body: "x" })).toEqual({ kind: "digest" });
  });
});
