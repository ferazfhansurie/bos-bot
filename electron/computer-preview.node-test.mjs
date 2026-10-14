import { test } from "node:test";
import assert from "node:assert/strict";
import { createComputerPreviewHandler } from "./computer-preview.mjs";
const tick = () => new Promise(resolve => setImmediate(resolve));
test("host preview never captures without a grant and discards grants revoked in flight", async () => {
  let allowed = false; let calls = 0; let finish;
  const replies = [];
  const receive = createComputerPreviewHandler({ allowed: () => allowed, isCurrent: () => true, send: value => replies.push(value), now: () => 1,
    capture: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const request = { type: "bos:computer-preview", requestId: "one", deadline: 100 };
  receive(request); await tick(); assert.equal(calls, 0); assert.equal(replies[0].ok, false);
  allowed = true; receive(request); receive({ ...request, requestId: "two" }); await tick(); assert.equal(calls, 1);
  allowed = false; finish("aGVsbG8="); await tick(); assert.equal(replies.length, 3); assert.ok(replies.every(reply => !reply.ok));
});
test("stale server generations and expired requests never deliver a capture", async () => {
  let current = true; let finish; const replies = [];
  const receive = createComputerPreviewHandler({ allowed: () => true, isCurrent: () => current, send: value => replies.push(value), now: () => 10,
    capture: () => new Promise(resolve => { finish = resolve; }) });
  assert.equal(receive({ type: "unrelated" }), false);
  receive({ type: "bos:computer-preview", requestId: "expired", deadline: 9 }); await tick(); assert.equal(finish, undefined);
  receive({ type: "bos:computer-preview", requestId: "live", deadline: 50 }); await tick(); current = false; finish("aGVsbG8="); await tick(); assert.deepEqual(replies, []);
});
