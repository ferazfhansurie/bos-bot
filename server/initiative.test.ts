// The initiative signal: when a manual ask counts as a repeat worth
// offering as a routine, and how the nudge budget keeps it from nagging.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  IGNORED_LIMIT,
  NUDGE_COOLDOWN_MS,
  NudgeLedgers,
  SAME_ASK_QUIET_MS,
  admitNudge,
  askTokens,
  emptyLedger,
  findRepeat,
  recordNudge,
  repeatSignalPrompt,
} from "./initiative.ts";
import { isQuietRoutineReply, QUIET_ROUTINE_REPLY } from "./system-prompt.ts";

const DAY = 24 * 60 * 60_000;
const now = new Date(2026, 9, 11, 10, 30).getTime();
const ask = (daysAgo: number, text: string) => ({ at: now - daysAgo * DAY, text });

describe("findRepeat", () => {
  const today = "check the open PR queue on bos-bot and list what needs review";

  it("needs the same ask on two earlier days", () => {
    expect(findRepeat(today, [ask(1, "check the open PR queue for bos-bot, what needs review")], now)).toBeNull();
    const signal = findRepeat(today, [
      ask(1, "check the open PR queue for bos-bot, what needs review"),
      ask(3, "can you check bos-bot open PR queue and list review needed"),
    ], now);
    expect(signal?.earlier.map((e) => e.at)).toEqual([now - DAY, now - 3 * DAY]);
  });

  it("does not count a burst on one day or today's follow-ups", () => {
    const sameDay = [ask(1, "check the open PR queue for bos-bot review"), { at: now - DAY + 60_000, text: "check open PR queue bos-bot review again" }];
    expect(findRepeat(today, sameDay, now)).toBeNull();
    expect(findRepeat(today, [ask(0, "check the open PR queue bos-bot review"), ask(1, "check the open PR queue bos-bot review")], now)).toBeNull();
  });

  it("ignores unrelated asks and asks outside the window", () => {
    expect(findRepeat(today, [ask(1, "draft a reply to aina about the raya poster"), ask(2, "clean my mac disk")], now)).toBeNull();
    expect(findRepeat(today, [ask(30, "check the open PR queue bos-bot review"), ask(40, "check open PR queue bos-bot review")], now)).toBeNull();
  });

  it("stays out of the way when a routine already covers the ask", () => {
    const history = [ask(1, "check the open PR queue for bos-bot review"), ask(2, "check open PR queue bos-bot review needed")];
    expect(findRepeat(today, history, now, ["Every weekday at 9, check the open PR queue on bos-bot and list what needs review."])).toBeNull();
  });

  it("does not match asks on their attachment tags or file paths", () => {
    const shot = (words: string) => `${words} <attached-image path="/Users/me/.bos-bot/attachments/a1.png" name="Screenshot 2026-10-01 at 10.00.png">`;
    expect(askTokens(shot("why no name"))).toEqual(new Set(["name"]));
    expect(askTokens("fix ~/Downloads/build.mov and ./server/index.ts please")).toEqual(new Set(["fix"]));
    expect(findRepeat(shot("spacing still not the best"), [ask(1, shot("why is this blocked")), ask(2, shot("can fix the alignment"))], now)).toBeNull();
  });

  it("catches a short repeat but not daily reactions", () => {
    expect(findRepeat("clean my mac", [ask(1, "help clean my mac"), ask(4, "need to clean mac again?")], now)?.earlier).toHaveLength(2);
    expect(findRepeat("nice good job", [ask(1, "nice good job"), ask(2, "nice amazing job")], now)).toBeNull();
    expect(findRepeat("still same why", [ask(1, "nah still same"), ask(2, "still same why")], now)).toBeNull();
  });

  it("does not fire on short chatter", () => {
    expect(askTokens("ok thanks")).toEqual(new Set());
    expect(findRepeat("yo", [ask(1, "yo"), ask(2, "yo")], now)).toBeNull();
  });
});

describe("nudge budget", () => {
  it("allows one nudge per cooldown and never the same ask twice in two weeks", () => {
    let ledger = recordNudge(emptyLedger(), "a", now, 0);
    expect(admitNudge(ledger, "b", now + NUDGE_COOLDOWN_MS - 1, 0).allowed).toBe(false);
    expect(admitNudge(ledger, "a", now + NUDGE_COOLDOWN_MS, 1).allowed).toBe(false);
    expect(admitNudge(ledger, "a", now + SAME_ASK_QUIET_MS + 1, 1).allowed).toBe(true);
    ledger = admitNudge(ledger, "b", now + NUDGE_COOLDOWN_MS, 1).ledger;
    expect(ledger.ignored).toBe(0);
  });

  it("goes quiet after offers in a row that were never taken", () => {
    let ledger = emptyLedger();
    let at = now;
    for (let i = 0; i < IGNORED_LIMIT; i += 1) {
      const admitted = admitNudge(ledger, `k${i}`, at, 2);
      expect(admitted.allowed).toBe(true);
      ledger = recordNudge(admitted.ledger, `k${i}`, at, 2);
      at += NUDGE_COOLDOWN_MS;
    }
    const muted = admitNudge(ledger, "next", at, 2);
    expect(muted.allowed).toBe(false);
    expect(muted.ledger.mutedUntil).toBeGreaterThan(at);
  });

  it("a taken offer resets the streak", () => {
    let ledger = recordNudge({ ...emptyLedger(), ignored: IGNORED_LIMIT - 1 }, "a", now, 2);
    ledger = admitNudge(ledger, "b", now + NUDGE_COOLDOWN_MS, 3).ledger;
    expect(ledger.ignored).toBe(0);
    expect(ledger.mutedUntil).toBeUndefined();
  });
});

describe("ledger file", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("survives a restart and forgets a deleted bot", () => {
    dir = mkdtempSync(join(tmpdir(), "initiative-"));
    const first = new NudgeLedgers(dir);
    first.set("bot", recordNudge(emptyLedger(), "a", now, 1));
    expect(new NudgeLedgers(dir).get("bot").offered).toEqual({ a: now });
    first.forget("bot");
    expect(new NudgeLedgers(dir).get("bot")).toEqual(emptyLedger());
  });
});

describe("prompt text", () => {
  it("names the earlier asks so the offer can cite them", () => {
    const text = repeatSignalPrompt({ key: "k", earlier: [ask(1, "check PR queue"), ask(3, "check the PR queue again")] });
    expect(text).toContain("2026-10-10");
    expect(text).toContain("2026-10-08");
    expect(text).toContain("Do not create it without a yes");
  });

  it("recognises the quiet routine reply and nothing else", () => {
    expect(isQuietRoutineReply(QUIET_ROUTINE_REPLY)).toBe(true);
    expect(isQuietRoutineReply(` \`${QUIET_ROUTINE_REPLY}\`.\n`)).toBe(true);
    expect(isQuietRoutineReply(`${QUIET_ROUTINE_REPLY}: but the build failed`)).toBe(false);
    expect(isQuietRoutineReply("no change")).toBe(false);
    expect(isQuietRoutineReply(undefined)).toBe(false);
  });
});
