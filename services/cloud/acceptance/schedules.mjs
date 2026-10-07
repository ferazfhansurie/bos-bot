import assert from 'node:assert/strict';

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`fixture deadline: ${label}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}

// Deterministic actual-admission barriers are supplied by a test-only server adapter.
// Sequential HTTP requests are not evidence of an admission race.
export async function bothOrders({ name, repetitions = 100, prepare, first, second, inspect, record }) {
  assert.ok(repetitions >= 100, 'P0 minimum is 100 per order');
  for (const order of ['first-before-second', 'second-before-first']) {
    for (let iteration = 0; iteration < repetitions; iteration++) {
      const fixture = await bounded(prepare({ order, iteration }), 'prepare');
      try {
        const paused = await bounded(fixture.pauseBeforeAdmission(order === 'first-before-second' ? 'second' : 'first'), 'pause');
        assert.equal(paused.boundary, 'before-protected-admission', 'must pause the real protected admission');
        const runFirst = order === 'first-before-second' ? first : second;
        const runSecond = order === 'first-before-second' ? second : first;
        const pending = Promise.resolve().then(() => runSecond(fixture));
        // Attach a rejection handler while waiting for the fixture to report its barrier.
        pending.catch(() => {});
        let resultA;
        try {
          await bounded(paused.waitUntilReached(), 'reach admission barrier');
          resultA = await bounded(runFirst(fixture), 'first admission');
        } finally {
          await bounded(paused.release(), 'release admission barrier');
          await bounded(pending.catch(() => {}), 'drain held request');
        }
        const resultB = await pending;
        await bounded(inspect({ fixture, order, iteration, resultA, resultB }), 'inspect');
        record({ type: 'race', name, order, iteration, state: 'passed' });
      } catch (error) {
        record({ type: 'race', name, order, iteration, state: 'failed', error: error.message });
        throw error;
      } finally { await bounded(fixture.cleanup(), 'cleanup'); }
    }
  }
}
export async function deliverySchedule({ name, count = 1000, operation, verify, record }) {
  assert.ok(count >= 1000, 'recovery schedule minimum is 1000 source operations');
  for (let index = 0; index < count; index++) await operation(index);
  await verify();
  record({ type: 'delivery_schedule', name, count, state: 'passed' });
}
