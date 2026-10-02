import { describe, expect, it } from "vitest";
import { MAX_BOT_RUN, isBareAck, isRoomStopCommand, trailingBotReplies } from "./room-loop-brake.ts";

describe("room loop brake", () => {
  it("recognises a bare stop and nothing longer", () => {
    for (const text of ["stop", "Stop", " STOP. ", "/stop", "stop!"]) expect(isRoomStopCommand(text)).toBe(true);
    for (const text of ["stop the build", "don't stop", "stopwatch", "@Jarvis stop"]) expect(isRoomStopCommand(text)).toBe(false);
  });

  it("treats acknowledgements as bare, real replies as content", () => {
    for (const text of ["ok", "Agreed.", "agreed @Jarvis", "ok thanks", "sounds good 👍", "👍", "@Infra noted", "got it, will do"]) {
      expect(isBareAck(text)).toBe(true);
    }
    for (const text of ["ok @Engineer please check the build", "agreed, but the cap should be 5", "done: 3 tests pass", "@Infra run the backup"]) {
      expect(isBareAck(text)).toBe(false);
    }
  });

  it("counts bot replies since the last human message", () => {
    const user = { role: "user", kind: "text", text: "hi" };
    const bot = { role: "bot", kind: "text", text: "reply" };
    const activity = { role: "bot", kind: "activity" };
    expect(trailingBotReplies([])).toBe(0);
    expect(trailingBotReplies([bot, user, bot, activity, bot])).toBe(2);
    expect(trailingBotReplies([user, bot, bot, bot])).toBe(MAX_BOT_RUN);
    expect(trailingBotReplies([bot, bot, user])).toBe(0);
  });
});
