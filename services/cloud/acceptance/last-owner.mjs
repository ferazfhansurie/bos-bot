import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bothOrders } from './schedules.mjs';

// External HTTP scenario. Expected membership never comes from service code.
export async function lastOwnerRemoval({ transport, hooks, inspectOwners, record }) {
  async function ok(path, options) {
    const response = await transport.request(path, options);
    assert.equal(response.status, 200, `${path}: ${JSON.stringify(response.data)}`);
    return response.data;
  }
  const actors = await Promise.all(['alice', 'bob'].map(subject => ok('/v2/test/sign-in', {
    method: 'POST', body: { subject: `fictional_a16_${subject}_${randomUUID()}` },
  })));
  await bothOrders({ name: 'a16-mutual-owner-removal', record,
    prepare: async ({ order, iteration }) => {
      const workspace = await ok('/v2/workspaces', { method: 'POST', token: actors[0].bearer,
        body: { name: `fictional a16 ${order} ${iteration}` } });
      const w = workspace.workspace_id;
      const room = await ok(`/v2/workspaces/${w}/rooms`, { method: 'POST', token: actors[0].bearer,
        body: { name: 'fictional owner invariant' } });
      const invite = await ok(`/v2/workspaces/${w}/invites`, { method: 'POST', token: actors[0].bearer,
        body: { role: 'owner', room_ids: [room.room_id] } });
      const redeemed = await ok('/v2/invites/redeem', { method: 'POST', token: actors[1].bearer,
        body: { token: invite.token } });
      assert.equal(redeemed.role, 'owner');
      assert.equal(redeemed.workspace_id, w);
      assert.deepEqual(await inspectOwners(w), actors.map(a => a.account_id).sort());
      let gate;
      return { w, room, actors,
        run: side => {
          const actor = side === 'first' ? 0 : 1;
          return transport.request(`/v2/workspaces/${w}/members/${actors[1 - actor].account_id}`,
            { method: 'DELETE', token: actors[actor].bearer });
        },
        pauseBeforeAdmission: async side => {
          const actor = side === 'first' ? 0 : 1;
          gate = randomUUID();
          await hooks('arm', { id: gate, point: 'member.remove.before_admission',
            match: { workspace_id: w, account_id: actors[actor].account_id,
              target_id: actors[1 - actor].account_id } });
          return { boundary: 'before-protected-admission',
            waitUntilReached: async () => {
              const deadline = performance.now() + 4000;
              while (performance.now() < deadline) {
                const state = await hooks('');
                const entered = state.gates.find(g => g.id === gate);
                if (entered?.entered && entered.waiting === 1) {
                  record({ type: 'admission_barrier', order, iteration, gate, state: entered });
                  return;
                }
                await new Promise(resolve => setTimeout(resolve, 10));
              }
              throw new Error('actual member-removal admission barrier was not reached');
            },
            release: async () => {
              const state = await hooks('');
              const held = state.gates.find(g => g.id === gate);
              assert.ok(held?.entered && held.waiting === 1,
                'admission barrier must remain held until explicit release');
              await hooks('release', { id: gate });
            },
          };
        },
        cleanup: async () => { if (gate) await hooks('release', { id: gate }); },
      };
    },
    first: fixture => fixture.run('first'), second: fixture => fixture.run('second'),
    inspect: async ({ fixture, order, iteration, resultA, resultB }) => {
      assert.equal(resultA.status, 200);
      assert.deepEqual(resultA.data, { removed: true });
      assert.equal(resultB.status, 403);
      assert.equal(resultB.data.error, 'forbidden');
      const winner = order === 'first-before-second' ? 0 : 1;
      const remaining = await inspectOwners(fixture.w);
      assert.deepEqual(remaining, [actors[winner].account_id], 'durable owner invariant');
      const snapshot = await ok(`/v2/workspaces/${fixture.w}/rooms/${fixture.room.room_id}/snapshot`, {
        method: 'POST', token: actors[winner].bearer, body: { thread_id: fixture.room.thread_id },
      });
      assert.deepEqual(snapshot.members.map(m => ({ account_id: m.account_id, role: m.role })),
        [{ account_id: actors[winner].account_id, role: 'owner' }]);
      const discovery = await ok('/v2/discovery/sync', { token: actors[1 - winner].bearer });
      assert.ok(!discovery.workspaces.some(w => w.workspace_id === fixture.w), 'removed owner sees workspace');
      const self = await transport.request(`/v2/workspaces/${fixture.w}/members/${actors[winner].account_id}`,
        { method: 'DELETE', token: actors[winner].bearer });
      assert.equal(self.status, 409);
      assert.equal(self.data.error, 'last_owner');
      assert.deepEqual(await inspectOwners(fixture.w), remaining, 'last owner must remain after self-removal denial');
      record({ type: 'owner_invariant', order, iteration, workspace_id: fixture.w,
        remaining, snapshot_owner: actors[winner].account_id, last_owner_denied: true });
    },
  });
}
