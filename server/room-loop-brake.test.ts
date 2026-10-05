import { describe, expect, it } from "vitest";
import { deferMentionCallback, isAddressedRoomReply, isBareAck, isRoomStopCommand, takeMentionCallback } from "./room-loop-brake.ts";

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

  it("delivers distinct results to the same lead and deduplicates a repeated result", () => {
    const spoken = new Set(["bos", "dev", "pix", "pipe"]);
    expect(takeMentionCallback(spoken)).toBeNull();
    deferMentionCallback(spoken, "dev", 2, "pix:tests checked");
    deferMentionCallback(spoken, "dev", 2, "pipe:server checked");
    deferMentionCallback(spoken, "dev", 2, "pix:tests checked");
    expect(takeMentionCallback(spoken)).toEqual({ botId: "dev", hop: 2 });
    expect(takeMentionCallback(spoken)).toEqual({ botId: "dev", hop: 2 });
    expect(takeMentionCallback(spoken)).toBeNull();
    deferMentionCallback(spoken, "dev", 4, "pix:tests checked");
    expect(takeMentionCallback(spoken)).toBeNull();
    deferMentionCallback(spoken, "dev", 4, "pix:implementation checked");
    expect(takeMentionCallback(spoken)).toEqual({ botId: "dev", hop: 4 });
    expect(takeMentionCallback(new Set(["dev"]))).toBeNull();
  });

  it("keeps different recipients and separate user rounds independent", () => {
    const spoken = new Set(["bos", "dev"]);
    deferMentionCallback(spoken, "bos", 2, "pipe:result");
    deferMentionCallback(spoken, "dev", 2, "pipe:result");
    expect(takeMentionCallback(spoken)?.botId).toBe("bos");
    expect(takeMentionCallback(spoken)?.botId).toBe("dev");
    const round = new Set(["dev"]);
    deferMentionCallback(round, "dev", 2, "pipe:result");
    expect(takeMentionCallback(round)?.botId).toBe("dev");
  });
});

it("recognizes exact addressed reply lines without waking contextual names", () => {
  for (const text of ["@bos check this", "done @bos: fixture ready", "summary\n@bos verify", "approved @bos", "ready @bos: result"]) expect(isAddressedRoomReply(text, "bos")).toBe(true);
  for (const text of ["Assigned; @bos is context", "Built CSV; @bos is context", "@boss verify", "quote: @bos verify", "> @bos verify"]) expect(isAddressedRoomReply(text, "bos")).toBe(false);
  expect(isAddressedRoomReply("@bot (qa) check", "bot (qa)")).toBe(true);
});

it("addresses every recipient in a leading room mention list without waking later contextual names", () => {
  const names = ["api", "ui", "bos", "bot (qa)"];
  for (const name of ["api", "ui", "bos"]) expect(isAddressedRoomReply("@api @ui @bos verify each part", name, names)).toBe(true);
  expect(isAddressedRoomReply("done: @api, @bot (qa) verify", "bot (qa)", names)).toBe(true);
  expect(isAddressedRoomReply("@api checked; @bos is context", "bos", names)).toBe(false);
  expect(isAddressedRoomReply("> @api @bos verify", "bos", names)).toBe(false);
  expect(isAddressedRoomReply("@api @boss verify", "bos", names)).toBe(false);
});
