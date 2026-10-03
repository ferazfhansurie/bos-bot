import { describe, expect, it } from "vitest";
import { deferMentionCallback, isBareAck, isRoomStopCommand, takeMentionCallback } from "./room-loop-brake.ts";

describe("room stop and mention routing", () => {
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

  it("calls back one member mentioned after it already spoke, once per chain", () => {
    const spoken = new Set(["bos", "dev"]);
    expect(takeMentionCallback(spoken)).toBeNull();
    deferMentionCallback(spoken, "bos", 2);
    deferMentionCallback(spoken, "dev", 3);
    expect(takeMentionCallback(spoken)).toEqual({ botId: "bos", hop: 2 });
    expect(takeMentionCallback(spoken)).toBeNull();
    // bos tagging dev back after its callback never starts a ping-pong.
    deferMentionCallback(spoken, "dev", 3);
    expect(takeMentionCallback(spoken)).toBeNull();
    expect(takeMentionCallback(new Set(["bos"]))).toBeNull();
  });
});
