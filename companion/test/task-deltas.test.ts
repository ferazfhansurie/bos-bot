import { expect, it } from 'vitest';
import { createSseScrubber } from '../src/wire.ts';
function frame(tasks: unknown[], seq = 1) { return { kind: 'bot', seq, bot: { id: 'b', tasks } }; }
function send(scrub: ReturnType<typeof createSseScrubber>, value: unknown) {
  return JSON.parse(scrub(`data: ${JSON.stringify(value)}\n\n`).slice(6));
}
it('sends a full baseline, then changes, order and deletions; reconnect resets', () => {
  const scrub = createSseScrubber(true);
  const a = { threadId: 'a', title: 'A', resumeCursors: { private: 'secret' } };
  const b = { threadId: 'b', title: 'B' };
  const first = send(scrub, frame([a, b]));
  expect(first.bot.tasks).toHaveLength(2);
  expect(first.bot.taskOrder).toBeUndefined();
  expect(JSON.stringify(first)).not.toContain('secret');
  const second = send(scrub, frame([b, { ...a, title: 'changed' }], 2));
  expect(second.bot.taskOrder).toEqual(['b', 'a']);
  expect(second.bot.tasks).toEqual([{ threadId: 'a', title: 'changed' }]);
  expect(second.seq).toBe(2);
  expect(send(scrub, frame([b], 3)).bot).toMatchObject({ tasks: [], taskOrder: ['b'] });
  expect(send(createSseScrubber(true), frame([b])).bot.taskOrder).toBeUndefined();
});
it('keeps legacy streams full and bounds cache without losing snapshots', () => {
  const legacy = createSseScrubber();
  const value = frame([{ threadId: 'a' }]);
  send(legacy, value);
  expect(send(legacy, value).bot.tasks).toHaveLength(1);
  const scrub = createSseScrubber(true);
  send(scrub, value);
  for (let i = 0; i < 17; i++) send(scrub, { kind: 'bot', bot: { id: `other${i}`, tasks: [] } });
  expect(send(scrub, value).bot.taskOrder).toBeUndefined();
});
it('cuts a busy update in a large task list by at least 85 percent', () => {
  const scrub = createSseScrubber(true);
  const tasks = Array.from({ length: 1000 }, (_, i) => ({ threadId: `thread-${i}`, title: 'an ordinary task title', modelSelection: { model: 'model', instanceId: 'instance' }, createdAt: 1700000000000, busy: false, unread: false }));
  send(scrub, frame(tasks));
  tasks[999].busy = true;
  const delta = send(scrub, frame(tasks, 2));
  expect(JSON.stringify(delta).length).toBeLessThan(JSON.stringify(frame(tasks)).length * .15);
  expect(delta.bot.tasks).toHaveLength(1);
});
