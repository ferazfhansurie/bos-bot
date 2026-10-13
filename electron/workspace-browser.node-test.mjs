import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createWorkspaceBrowserRegistry, workspaceBrowserPartition } from "./workspace-browser.mjs";
import { hardenWebviewAttach } from "./tools-browser.mjs";

test("workspace partition isolates bot and thread identities and hides their names", () => {
  const a = workspaceBrowserPartition(JSON.stringify(["bot-a", "thread-a"]));
  assert.equal(a, workspaceBrowserPartition(JSON.stringify(["bot-a", "thread-a"])));
  assert.notEqual(a, workspaceBrowserPartition(JSON.stringify(["bot-a", "thread-b"])));
  assert.notEqual(a, workspaceBrowserPartition(JSON.stringify(["bot-b", "thread-a"])));
  assert.match(a, /^persist:bos-workspace-browser-[a-f0-9]{64}$/);
  for (const value of [undefined, "", "x".repeat(4097)]) assert.throws(() => workspaceBrowserPartition(value));
});

test("attach retains main-selected workspace partition and original hardening", () => {
  const partition = workspaceBrowserPartition("workspace");
  const prefs = { preload: "evil", nodeIntegration: true, session: { privileged: true } };
  const params = { src: "https://example.com", partition: "persist:app" };
  assert.equal(hardenWebviewAttach(prefs, params, { partition }), true);
  assert.equal(prefs.partition, partition);
  assert.equal(params.partition, partition);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.session, undefined);
});

function guest(id) { return Object.assign(new EventEmitter(), { id }); }
function item(name = "report.pdf") {
  return Object.assign(new EventEmitter(), {
    getFilename: () => name, getURL: () => "https://example.com/report.pdf",
    getReceivedBytes: () => 25, getTotalBytes: () => 100,
  });
}

test("popup identity follows original guest and expires when it dies", () => {
  const registry = createWorkspaceBrowserRegistry();
  const a = registry.register("a");
  const b = registry.register("b");
  const sourceA = guest(1), sourceB = guest(2);
  registry.attach(sourceA, a); registry.attach(sourceB, b);
  assert.deepEqual(registry.source(sourceA), { guestId: 1, partition: a });
  assert.deepEqual(registry.source(sourceB), { guestId: 2, partition: b });
  sourceA.emit("destroyed");
  assert.equal(registry.source(sourceA), null);
  assert.equal(registry.has("persist:app"), false);
});

test("download history is workspace scoped, bounded and excludes native paths", () => {
  const emitted = [];
  const registry = createWorkspaceBrowserRegistry({ notify: (row) => emitted.push(row), limit: 2, now: () => 123 });
  const a = registry.register("a"), b = registry.register("b"), source = guest(1);
  registry.attach(source, a);
  const first = item();
  registry.trackDownload(a, {}, first, source);
  first.emit("updated", {}, "interrupted");
  first.emit("done", {}, "completed");
  assert.equal(registry.list(a)[0].state, "completed");
  assert.equal(registry.list(a)[0].completedAt, 123);
  assert.equal(emitted[0].state, "progressing", "event records are immutable snapshots");
  registry.trackDownload(a, {}, item("2.pdf"), source);
  registry.trackDownload(a, {}, item("3.pdf"), source);
  assert.equal(registry.list(a).length, 2);
  assert.deepEqual(registry.list(b), []);
  assert.equal("savePath" in registry.list(a)[0], false);
  const copy = registry.list(a); copy[0].state = "fake";
  assert.equal(registry.list(a)[0].state, "progressing");
  assert.throws(() => registry.list("persist:other"));
});

test("downloads from other workspace, unknown and dead guests fail closed", () => {
  const registry = createWorkspaceBrowserRegistry();
  const a = registry.register("a"), b = registry.register("b"), source = guest(1);
  registry.attach(source, a);
  let blocked = 0;
  const event = { preventDefault() { blocked++; } };
  registry.trackDownload(b, event, item(), source);
  registry.trackDownload(a, event, item(), undefined);
  source.emit("destroyed");
  registry.trackDownload(a, event, item(), source);
  assert.equal(blocked, 3);
  assert.deepEqual(registry.list(a), []);
});
