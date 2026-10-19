import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('preflight reports unrelated services but still blocks active installers and restart jobs', () => {
  const script = fileURLToPath(new URL('./resources/updater/preflight.py', import.meta.url));
  const result = spawnSync('python3', ['-c', `
import json, runpy, sys
scope = runpy.run_path(sys.argv[1])
launchd = scope['launchd']
fixtures = [
    ('26036', 'com.bosweb.waforward', True),
    ('-', 'com.bosweb.waforward-idle', True),
    ('123', 'ai.bos.bos.install', False),
    ('-', 'ai.bos.bos.restart-keepalive', True),
    ('-', 'ai.bos.bos.steer-t9-install', False),
    ('123', 'application.ai.bos.bot.123', True),
    ('123', 'ai.openmausbot.update', False),
    ('123', 'com.other.install', True),
]
listing = 'PID\\tStatus\\tLabel\\n' + '\\n'.join(pid+'\\t0\\t'+label for pid,label,_ in fixtures)
def fake_sh(*args):
    if args == ('launchctl', 'list'): return listing
    label = args[-1].split('/')[-1]
    return '\\n\\tpath = /fixtures/'+label+'\\n\\tprogram = /usr/bin/python3\\n'
def fake_plist(path):
    label = path.split('/')[-1]
    return {'KeepAlive': next(ka for _,name,ka in fixtures if name == label)}
launchd.__globals__['sh'] = fake_sh
launchd.__globals__['plist'] = fake_plist
print(json.dumps(launchd()))
`, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const jobs = JSON.parse(result.stdout);
  assert.deepEqual(jobs.filter(j => j.blocking).map(j => j.label), [
    'ai.bos.bos.install', 'ai.bos.bos.restart-keepalive', 'ai.openmausbot.update',
  ]);
  assert.equal(jobs.find(j => j.label === 'com.bosweb.waforward').reason, 'unrelated service (report only)');
  assert.equal(jobs.find(j => j.label === 'ai.bos.bos.steer-t9-install').reason, 'idle one-shot (report only)');
  assert.equal(jobs.find(j => j.label.startsWith('application.')).reason, 'app itself');
});
