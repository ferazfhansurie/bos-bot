import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewSharedComputerGrant } from './computer-sharing-review.mjs';

function fixture(response = 0) {
  const calls = [];
  const env = { id: 'client-a', name: 'Client A', origin: 'https://client-a.example' };
  const identity = { sessionId: 'owner-session', environmentId: 'workspace-a' };
  const controller = { inspectIdentity: async () => identity, save: async (...args) => { calls.push(['save', ...args]); return { enabled: true }; } };
  return { calls, env, identity, args: {
    env, input: { folders: [], terminal: true, computer: true }, controller: () => controller,
    validateFolders: async folders => folders,
    confirm: async options => { calls.push(['review', options]); return { response }; },
    assertWorkspace: () => { calls.push(['workspace']); },
    enable: async () => { calls.push(['enable']); },
  } };
}

test('cancelled native owner review cannot enable the feature or create a grant', async () => {
  const { args, calls } = fixture(1);
  assert.equal(await reviewSharedComputerGrant(args), null);
  assert.deepEqual(calls.map(call => call[0]), ['review']);
  assert.equal(calls[0][1].defaultId, 1);
  assert.equal(calls[0][1].cancelId, 1);
});

test('full-computer switch reviews exact workspace and broad access before enabling', async () => {
  const { args, calls, env, identity } = fixture();
  assert.deepEqual(await reviewSharedComputerGrant(args), { enabled: true });
  assert.deepEqual(calls.map(call => call[0]), ['review', 'workspace', 'enable', 'save']);
  const detail = calls[0][1].detail;
  assert.match(detail, /Workspace: https:\/\/client-a.example/);
  assert.match(detail, /Terminal: UNRESTRICTED commands as your user/);
  assert.match(detail, /including credentials/);
  assert.match(detail, /Computer control: can view your screen and operate logged-in apps/);
  assert.match(detail, /Browser: off/);
  assert.deepEqual(calls[3], ['save', env, { folders: [], terminal: true, computer: true, browser: false }, identity]);
});

test('limited folder grant keeps terminal and screen off and reviews the folder path', async () => {
  const { args, calls } = fixture();
  const folder = { id: 'folder-a', path: '/fixture/Client A', name: 'Client A', write: false };
  args.input = { folders: [folder], terminal: false, computer: false };
  await reviewSharedComputerGrant(args);
  assert.match(calls[0][1].detail, /Read only: \/fixture\/Client A/);
  assert.match(calls[0][1].detail, /Terminal: off/);
  assert.match(calls[0][1].detail, /Computer control: off/);
  assert.deepEqual(calls.at(-1)[2], { ...args.input, browser: false });
});

test('browser grant is reviewed in plain words and saved only when asked for', async () => {
  const { args, calls } = fixture();
  args.input = { folders: [], terminal: false, computer: false, browser: true };
  await reviewSharedComputerGrant(args);
  assert.match(calls[0][1].detail, /Browser: bots open a BOS browser window here/);
  assert.equal(calls.at(-1)[2].browser, true);
});

test('stale workspace or failed feature enable cannot persist a grant', async () => {
  for (const failure of ['workspace', 'enable']) {
    const { args, calls } = fixture();
    if (failure === 'workspace') args.assertWorkspace = () => { throw new Error('forgotten'); };
    else args.enable = async () => { throw new Error('local server unavailable'); };
    await assert.rejects(reviewSharedComputerGrant(args));
    assert.equal(calls.some(call => call[0] === 'save'), false);
  }
});

// Keep the real connector's feature gate in this path: a mocked identity would
// hide a first-time toggle that fails before it can show the native review.
for (const response of [0, 1]) test(`real disabled connector reaches native review (${response === 0 ? 'allow' : 'cancel'})`, async () => {
  const { default: fs } = await import('node:fs/promises');
  const { default: os } = await import('node:os');
  const { default: path } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { createComputerSharing } = await import('./computer-sharing.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bos-sharing-review-'));
  const file = path.join(directory, 'grants.json');
  const env = { id: randomUUID(), name: 'Fixture', origin: 'https://fixture.invalid' };
  const sessionId = randomUUID(), environmentId = randomUUID();
  let enabled = false, reviewed = false;
  const requests = [];
  const client = createComputerSharing({ file, environments: () => [env], enabled: async () => enabled,
    fetch: async (url, options) => {
      requests.push({ url, method: options.method });
      assert.equal(options.method, 'GET', 'review must not register or execute remote work');
      return new Response(JSON.stringify(url.endsWith('/api/auth/session')
        ? { kind: 'session', id: sessionId } : { environmentId, capabilities: { sharedComputers: true } }));
    },
  });
  try {
    const result = await reviewSharedComputerGrant({ env, input: { folders: [], terminal: true, computer: true },
      controller: () => ({ inspectIdentity: client.inspectIdentity, save: (workspace, input, info) => client.save(workspace, input, info, { activate: false }) }),
      validateFolders: async folders => folders,
      confirm: async () => { assert.equal(enabled, false); reviewed = true; return { response }; },
      assertWorkspace: () => {}, enable: async () => { assert.equal(reviewed, true); enabled = true; },
    });
    assert.equal(reviewed, true);
    assert.equal(enabled, response === 0);
    assert.equal(client.state(env.id).enabled, response === 0);
    assert.equal(requests.length, response === 0 ? 4 : 2);
    if (response === 0) {
      assert.equal(result.enabled, true);
      assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).records[env.id].enabled, true);
    } else {
      assert.equal(result, null);
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
    }
  } finally { client.close(); await fs.rm(directory, { recursive: true }); }
});
