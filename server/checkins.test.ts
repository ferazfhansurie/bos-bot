// Check-in items: source refusal, dedupe by source + state, the "already
// handled" resolvers, the kind mute, the no-model gate and the ledger import.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CHECKIN_IGNORED_MS,
  CheckinStore,
  type CheckinThreadView,
  type CheckinWorld,
  checkinShouldRun,
  nextMorning,
} from "./checkins.ts";
import { CHECKIN_MUTE_MS, CHECKIN_NO_LIMIT, emptyLedger, kindMuted, recordKindAnswer } from "./initiative.ts";
import { checkinOwnerBotId, type CheckinSource } from "../shared/checkins.ts";

const T0 = Date.UTC(2026, 9, 27, 1, 0); // 09:00 in Kuala Lumpur

let dir: string;
let threads: Record<string, CheckinThreadView>;
let routines: Record<string, { lastRunStatus?: string; lastRunFinishedAt?: number }>;
const world: CheckinWorld = {
  thread: (id) => threads[id] ?? null,
  routine: (id) => routines[id] ?? null,
};
const never = () => false;

const idle = (extra: Partial<CheckinThreadView> = {}): CheckinThreadView => ({
  botId: "bos", closed: false, archived: false, running: false, waiting: false, ...extra,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "checkins-"));
  threads = { t1: idle(), t2: idle({ waiting: true }) };
  routines = { r1: { lastRunStatus: "failed", lastRunFinishedAt: T0 - 1000 } };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = {
  botId: "bos",
  kind: "decide",
  title: "ship the acme fix?",
  why: "it waits on you since monday",
  sources: [{ type: "thread", ref: "t1" }],
  plan: "merge and deploy the fix",
};

describe("propose", () => {
  it("refuses an item with no source, or a source that does not exist", () => {
    const store = new CheckinStore(dir);
    const none = store.propose({ ...base, sources: [] }, world, T0, never);
    expect(none.ok).toBe(false);
    const ghost = store.propose({ ...base, sources: [{ type: "thread", ref: "nope" }] }, world, T0, never);
    expect(ghost.ok).toBe(false);
    const badCommit = store.propose({ ...base, sources: [{ type: "commit", ref: "not a sha" }] }, world, T0, never);
    expect(badCommit.ok).toBe(false);
    const appNoLink = store.propose({ ...base, sources: [{ type: "app", ref: "crm" }] }, world, T0, never);
    expect(appNoLink.ok).toBe(false);
  });

  it("needs a plan or draft for decide and tonight items", () => {
    const store = new CheckinStore(dir);
    const result = store.propose({ ...base, plan: undefined }, world, T0, never);
    expect(result.ok).toBe(false);
    const did = store.propose({ ...base, kind: "did", plan: undefined }, world, T0, never);
    expect(did.ok).toBe(true);
  });

  it("dedupes the same source in the same state, updates a changed open item", () => {
    const store = new CheckinStore(dir);
    const first = store.propose({ ...base, stateHash: "a" }, world, T0, never);
    expect(first.ok && first.status).toBe("created");
    const again = store.propose({ ...base, stateHash: "a", title: "worded differently" }, world, T0 + 1, never);
    expect(again.ok && again.status).toBe("duplicate");
    const changed = store.propose({ ...base, stateHash: "b", title: "new state" }, world, T0 + 2, never);
    expect(changed.ok && changed.status).toBe("updated");
    expect(store.all()).toHaveLength(1);
    expect(store.all()[0]!.title).toBe("new state");
  });

  it("never re-asks an answered item, but resurfaces it when its state changes", () => {
    const store = new CheckinStore(dir);
    const first = store.propose({ ...base, stateHash: "a" }, world, T0, never);
    if (!first.ok) throw new Error(first.error);
    store.act(first.item.id, "no", T0 + 10, "Asia/Kuala_Lumpur");
    const same = store.propose({ ...base, stateHash: "a" }, world, T0 + 20, never);
    expect(same.ok && same.status).toBe("duplicate");
    expect(store.visible(T0 + 20)).toHaveLength(0);
    const moved = store.propose({ ...base, stateHash: "b" }, world, T0 + 30, never);
    expect(moved.ok && moved.status).toBe("resurfaced");
    expect(store.visible(T0 + 30)).toHaveLength(1);
  });

  it("caps one check-in run at three items", () => {
    const store = new CheckinStore(dir);
    for (let i = 0; i < 3; i += 1) {
      const ok = store.propose({ ...base, sources: [{ type: "url", ref: `https://x.test/${i}` }], threadId: "run" }, world, T0, never);
      expect(ok.ok).toBe(true);
    }
    const fourth = store.propose({ ...base, sources: [{ type: "url", ref: "https://x.test/4" }], threadId: "run" }, world, T0, never);
    expect(fourth.ok).toBe(false);
  });

  it("refuses a muted kind", () => {
    const store = new CheckinStore(dir);
    const result = store.propose(base, world, T0, (kind) => kind === "decide");
    expect(result.ok).toBe(false);
  });

  it("persists across a restart", () => {
    const store = new CheckinStore(dir);
    store.propose(base, world, T0, never);
    expect(new CheckinStore(dir).visible(T0)).toHaveLength(1);
  });
});

describe("already handled", () => {
  const propose = (store: CheckinStore, input: Record<string, unknown> = {}) => {
    const result = store.propose({ ...base, ...input }, world, T0, never);
    if (!result.ok) throw new Error(result.error);
    return result.item;
  };

  it("drops an item when the owner replied in its thread", () => {
    const store = new CheckinStore(dir);
    propose(store);
    expect(store.refresh(world, T0 + 1)).toHaveLength(0);
    threads.t1 = idle({ lastUserMessageAt: T0 + 5 });
    const changed = store.refresh(world, T0 + 10);
    expect(changed[0]?.item.resolvedBy).toBe("owner replied");
    expect(store.visible(T0 + 10)).toHaveLength(0);
  });

  it("drops an item when its thread is closed or archived", () => {
    const store = new CheckinStore(dir);
    propose(store);
    threads.t1 = idle({ closed: true });
    expect(store.refresh(world, T0 + 1)[0]?.item.resolvedBy).toBe("thread closed");
  });

  it("drops a stall once the job finished by itself", () => {
    const store = new CheckinStore(dir);
    propose(store, { kind: "broke", sources: [{ type: "thread", ref: "t2" }] });
    threads.t2 = idle({ lastReplyAt: T0 + 50 });
    expect(store.refresh(world, T0 + 60)[0]?.item.resolvedBy).toBe("job finished");
  });

  it("keeps a report of finished work until the person sees it", () => {
    const store = new CheckinStore(dir);
    propose(store, { kind: "did", plan: undefined });
    threads.t1 = idle({ lastReplyAt: T0 + 50 });
    expect(store.refresh(world, T0 + 60)).toHaveLength(0);
  });

  it("drops a broken routine once it ran clean", () => {
    const store = new CheckinStore(dir);
    propose(store, { kind: "broke", sources: [{ type: "routine", ref: "r1" }] });
    expect(store.refresh(world, T0 + 1)).toHaveLength(0);
    routines.r1 = { lastRunStatus: "completed", lastRunFinishedAt: T0 + 100 };
    expect(store.refresh(world, T0 + 200)[0]?.item.resolvedBy).toBe("routine recovered");
  });

  it("marks an approved item done when its thread finished", () => {
    const store = new CheckinStore(dir);
    const item = propose(store);
    store.act(item.id, "approve", T0 + 10, "Asia/Kuala_Lumpur");
    threads.job = idle({ running: true });
    store.attachThread(item.id, "job", T0 + 11);
    expect(store.refresh(world, T0 + 20)).toHaveLength(0);
    threads.job = idle({ lastReplyAt: T0 + 30 });
    const changed = store.refresh(world, T0 + 40);
    expect(changed[0]?.item.outcome).toBe("done");
    expect(store.counts(T0 + 40).done).toBe(1);
  });

  it("expires an untouched item as ignored", () => {
    const store = new CheckinStore(dir);
    propose(store);
    const changed = store.refresh(world, T0 + CHECKIN_IGNORED_MS + 1);
    expect(changed[0]?.answer).toBe("ignored");
    expect(store.counts(T0 + CHECKIN_IGNORED_MS + 1).no).toBe(0);
  });
});

describe("not now", () => {
  it("brings the item back at 9am the next day in the person's timezone", () => {
    const store = new CheckinStore(dir);
    const result = store.propose(base, world, T0, never);
    if (!result.ok) throw new Error(result.error);
    const snoozed = store.act(result.item.id, "not-now", T0 + 60_000, "Asia/Kuala_Lumpur");
    if (typeof snoozed === "string") throw new Error(snoozed);
    expect(snoozed.snoozedUntil).toBe(T0 + 24 * 60 * 60_000);
    expect(store.visible(T0 + 2 * 60_000)).toHaveLength(0);
    expect(store.counts(T0 + 2 * 60_000).later).toBe(1);
    store.refresh(world, T0 + 24 * 60 * 60_000);
    expect(store.visible(T0 + 24 * 60 * 60_000)).toHaveLength(1);
  });

  it("an early-morning snooze still waits for tomorrow, not today's 9am", () => {
    const sevenAm = T0 - 2 * 60 * 60_000;
    expect(nextMorning(sevenAm, "Asia/Kuala_Lumpur")).toBe(T0 + 24 * 60 * 60_000);
  });
});

describe("kind mute", () => {
  it("three no's in a row mute a kind for two weeks, a yes clears the count", () => {
    let ledger = emptyLedger();
    ledger = recordKindAnswer(ledger, "did", "no", T0);
    ledger = recordKindAnswer(ledger, "did", "no", T0);
    ledger = recordKindAnswer(ledger, "did", "yes", T0);
    ledger = recordKindAnswer(ledger, "did", "no", T0);
    expect(kindMuted(ledger, "did", T0)).toBe(false);
    for (let i = 1; i < CHECKIN_NO_LIMIT; i += 1) ledger = recordKindAnswer(ledger, "did", "no", T0);
    expect(kindMuted(ledger, "did", T0 + 1)).toBe(true);
    expect(kindMuted(ledger, "decide", T0 + 1)).toBe(false);
    expect(kindMuted(ledger, "did", T0 + CHECKIN_MUTE_MS + 1)).toBe(false);
  });

  it("an ignored item counts half a no", () => {
    let ledger = emptyLedger();
    for (let i = 0; i < 5; i += 1) ledger = recordKindAnswer(ledger, "broke", "ignored", T0);
    expect(kindMuted(ledger, "broke", T0)).toBe(false);
    ledger = recordKindAnswer(ledger, "broke", "ignored", T0);
    expect(kindMuted(ledger, "broke", T0)).toBe(true);
  });
});

describe("gate", () => {
  it("skips the model when nothing moved since the last check-in", () => {
    const quiet = { lastCheckinAt: T0, lastThreadActivityAt: T0 - 1, lastRoutineFinishedAt: T0 - 1, lastItemChangeAt: T0 - 1 };
    expect(checkinShouldRun(quiet)).toBe(false);
    expect(checkinShouldRun({ ...quiet, lastThreadActivityAt: T0 + 1 })).toBe(true);
    expect(checkinShouldRun({ ...quiet, lastRoutineFinishedAt: T0 + 1 })).toBe(true);
    expect(checkinShouldRun({ ...quiet, lastCheckinAt: undefined })).toBe(true);
  });
});

describe("ledger import", () => {
  it("brings answered items over so they are never asked again, latest line wins", () => {
    const store = new CheckinStore(dir);
    const lines = [
      { key: "thread:t1", state_hash: "h1", kind: "decide", title: "ship it?", outcome: "surfaced", at: "2026-10-26T01:00:00Z" },
      { key: "thread:t1", state_hash: "h1", kind: "decide", title: "ship it?", outcome: "no", at: "2026-10-26T02:00:00Z" },
      { key: "wa:6012", outcome: "no", at: "2026-10-26T02:00:00Z" },
      { key: "routine:r1", state_hash: "h2", kind: "broke", title: "disk check failed", outcome: "done", at: "2026-10-26T03:00:00Z" },
      { key: "commits:prod", state_hash: "h3", kind: "did", title: "3 fixes shipped", outcome: "candidate", at: "2026-10-26T03:00:00Z" },
    ].map((line) => JSON.stringify(line)).join("\n") + "\nnot json\n";
    const result = store.importLedger("bos", lines, T0);
    expect(result.imported).toBe(2);
    expect(store.visible(T0)).toHaveLength(0);
    const again = store.propose({ ...base, stateHash: "h1" }, world, T0, never);
    expect(again.ok && again.status).toBe("duplicate");
  });
});

describe("owner", () => {
  it("runs approve on the bot behind the first thread source, else the proposer", () => {
    const base = { botId: "chief", sources: [] as CheckinSource[] };
    expect(checkinOwnerBotId(base)).toBe("chief");
    expect(checkinOwnerBotId({ ...base, sources: [{ type: "commit", ref: "abc1234" }] })).toBe("chief");
    expect(checkinOwnerBotId({ ...base, sources: [{ type: "url", ref: "https://x.test/" }, { type: "thread", ref: "t1", botId: "cash" }] })).toBe("cash");
  });
});
