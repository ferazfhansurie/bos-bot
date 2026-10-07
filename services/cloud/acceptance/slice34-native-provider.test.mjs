import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerTurn } from './slice34-native-host.mjs';
const pinned = { provider: 'anthropic', model: 'claude-sonnet-4-6', config_revision: '1' };
function provider(events) {
  let listener, sent, interrupts = 0;
  return { adapter: {
    onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
    async sendTurn(input) { sent = input; queueMicrotask(() => events.forEach(e => listener?.({ threadId: input.threadId, turnId: 'receipt-1', ...e }))); return { turnId: 'receipt-1' }; },
    async interruptTurn() { interrupts++; },
  }, get sent() { return sent; }, get interrupts() { return interrupts; } };
}
const complete = [
  { type: 'session.started', sessionId: 'native-1', model: pinned.model },
  { type: 'content.delta', streamKind: 'assistant_text', delta: 'exact e\u0301' },
  { type: 'item.completed', itemType: 'assistant_text', text: 'exact e\u0301' },
  { type: 'turn.completed', ok: true },
];
test('native ingress is exact and isolated; result needs a provider-reported pinned model', async () => {
  const p = provider(complete), deltas = [], signal = new AbortController().signal;
  const r = await providerTurn(p, { invocation: { invocation_id: 'i', bot_id: 'b', model: pinned }, prompt: 'e\u0301\u0000🦊\nexact' }, { signal, onDelta: v => deltas.push(v) });
  assert.equal(p.sent.text, 'e\u0301\u0000🦊\nexact');
  assert.equal(p.sent.sharedContext.mode, 'conversation-only');
  assert.equal(p.sent.model, pinned.model);
  assert.equal(r.ok, true); assert.equal(r.model, pinned.model);
  assert.equal(r.text, 'exact e\u0301'); assert.deepEqual(deltas, ['exact e\u0301']);
});
for (const [name, events] of [
  ['missing model receipt', complete.filter(e => e.type !== 'session.started')],
  ['wrong provider model', complete.map(e => e.type === 'session.started' ? { ...e, model: 'different' } : e)],
  ['quota model switch', [{ ...complete[0] }, { type: 'model.switched', to: 'different' }, ...complete.slice(1)]],
  ['unexpected native tool', [complete[0], { type: 'request.opened', request: { kind: 'tool' } }, ...complete.slice(1)]],
]) test(name + ' fails closed', async () => {
  const p = provider(events);
  const r = await providerTurn(p, { invocation: { invocation_id: 'i', bot_id: 'b', model: pinned }, prompt: 'exact' }, { signal: new AbortController().signal, onDelta() {} });
  assert.equal(r.ok, false);
});
