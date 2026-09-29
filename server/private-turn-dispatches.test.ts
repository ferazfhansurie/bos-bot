import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PrivateTurnDispatches } from "./private-turn-dispatches.ts";

it("persists before dispatch, refuses duplicate generations and fences stale terminal cleanup", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-private-dispatch-"));
  try {
    const file = join(root, "receipts.json");
    const journal = new PrivateTurnDispatches(file);
    journal.prepare({ id: "generation-one", botId: "bot", threadId: "thread", sourceId: "message", createdAt: 1 });
    expect(new PrivateTurnDispatches(file).all()).toMatchObject([{ id: "generation-one", state: "dispatching" }]);
    expect(() => journal.prepare({ id: "generation-one", botId: "bot", threadId: "thread", createdAt: 2 })).toThrow();
    journal.bind("generation-one", "provider-one");
    expect(journal.settle("generation-one", "thread", "provider-old")).toBe(false);
    journal.hold("generation-one");
    expect(new PrivateTurnDispatches(file).all()[0].state).toBe("outcome-unknown");
    journal.prepare({ id: "generation-two", botId: "bot", threadId: "thread", createdAt: 3 });
    journal.bind("generation-two", "provider-two");
    expect(journal.settle("generation-one", "thread", "provider-one")).toBe(false);
    expect(journal.all().map(row => row.id)).toEqual(["generation-one", "generation-two"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("fails closed on corrupt journal and failed persistence does not admit dispatch", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-private-dispatch-"));
  try {
    const file = join(root, "receipts.json");
    writeFileSync(file, "{}");
    expect(() => new PrivateTurnDispatches(file)).toThrow();
    const journal = new PrivateTurnDispatches(join(root, "absent", "receipts.json"));
    rmSync(root, { recursive: true });
    writeFileSync(root, "not a directory");
    expect(() => journal.prepare({ id: "generation", botId: "bot", threadId: "thread", createdAt: 1 })).toThrow();
    expect(journal.all()).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


it("fences provider-id reuse even after a successful receipt is retired", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-private-fencing-"));
  try {
    const file = join(root, "receipts.json");
    const journal = new PrivateTurnDispatches(file);
    journal.prepare({ id: "one", botId: "bot", threadId: "thread", createdAt: 1 });
    journal.bind("one", "same-provider-id");
    expect(journal.settle("stale", "thread", "same-provider-id")).toBe(false);
    expect(journal.settle("one", "thread", "same-provider-id")).toBe(true);
    const reloaded = new PrivateTurnDispatches(file);
    expect(() => reloaded.prepare({ id: "one", botId: "bot", threadId: "thread", createdAt: 2 })).toThrow("already used");
    reloaded.prepare({ id: "two", botId: "bot", threadId: "thread", createdAt: 2 });
    expect(() => reloaded.bind("two", "same-provider-id")).toThrow("reused");
    expect(reloaded.settle("one", "thread", "same-provider-id")).toBe(false);
    expect(reloaded.all().map(row => row.id)).toEqual(["two"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
it("human review holds active work, scopes the receipt and durably retains unknown audit", () => {
 const root=mkdtempSync(join(tmpdir(),"omb-reviewed-dispatch-"));
 try {
  const file=join(root,"receipts.json"), journal=new PrivateTurnDispatches(file);
  journal.prepare({id:"review-one",botId:"bot",threadId:"thread",createdAt:1});
  expect(()=>journal.acknowledge("review-one","bot","thread","desktop-owner")).toThrow(/active/);
  journal.hold("review-one");
  expect(()=>journal.acknowledge("review-one","bot","other-thread","desktop-owner")).toThrow(/scope/);
  const reviewed=journal.acknowledge("review-one","bot","thread","desktop-owner");
  expect(reviewed).toMatchObject({state:"outcome-unknown",reviewedBy:"desktop-owner"});
  expect(reviewed.reviewedAt).toBeGreaterThan(0);expect(journal.pending()).toHaveLength(0);
  const reloaded=new PrivateTurnDispatches(file);
  expect(reloaded.acknowledge("review-one","bot","thread","another-admin")).toEqual(reviewed);
  expect(reloaded.all()).toHaveLength(1);expect(reloaded.pending()).toHaveLength(0);
 } finally {rmSync(root,{recursive:true,force:true});}
});

it("rejects blank review actors in durable receipts and acknowledgment without releasing a hold", () => {
  const root = mkdtempSync(join(tmpdir(), "omb-private-review-actor-"));
  try {
    const file = join(root, "receipts.json");
    const journal = new PrivateTurnDispatches(file);
    journal.prepare({ id: "review", botId: "bot", threadId: "thread", createdAt: 1 });
    journal.hold("review");
    expect(() => journal.acknowledge("review", "bot", "thread", " \t\n ")).toThrow();
    expect(journal.pending()).toHaveLength(1);
    const persisted = JSON.parse(readFileSync(file, "utf8"));
    persisted.records[0].reviewedAt = 10;
    persisted.records[0].reviewedBy = " \t\n ";
    writeFileSync(file, JSON.stringify(persisted));
    expect(() => new PrivateTurnDispatches(file)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
