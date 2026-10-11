// Real loopback HTTP acceptance for the phone hydration client. No live BOS data.
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
let active = 0, maximum = 0;
const paths = [];
const tasks = Array.from({ length: 9 }, (_, i) => ({ threadId: `wait-${i}`, title: 'Waiting', createdAt: 1, activity: 'waiting-on-you' }));
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/bots?')) {
    res.end(JSON.stringify({ bots: [{ id: 'bot', threadId: 'selected', name: 'Fixture', title: 'Fixture', description: '', notifications: true, color: 'blue', unread: false, createdAt: 1, busy: false, modelSelection: { instanceId: 'codex', model: 'default' }, messages: [], tasks: [...tasks, tasks[0]] }], groups: [] }));
    return;
  }
  const match = req.url.match(/^\/api\/threads\/(wait-[0-8])\/messages\?limit=50$/);
  if (!match) { res.writeHead(404).end('{}'); return; }
  paths.push(match[1]); active++; maximum = Math.max(maximum, active);
  setTimeout(() => {
    active--;
    res.end(JSON.stringify({ messages: [{ id: `approval-${match[1]}`, role: 'bot', kind: 'options', at: 1, card: { title: 'Approval', subtitle: 'Fixture', options: ['Allow', 'Deny'], requestId: `request-${match[1]}`, tool: 'fixture' } }], hasMore: false }));
  }, 200);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BOSBOT_|BOS_|OMB_|OGB_|OPENMAUSBOT_)/.test(key)));
  env.WAITING_PAGES_FIXTURE_PORT = String(server.address().port);
  const started = Date.now();
  const child = spawn('swift', ['test', '--package-path', 'ios', '--skip-build', '--filter', 'WaitingPagesHTTPFixtureTests'], { env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(code, 0);
  assert.equal(paths.length, 9); assert.equal(new Set(paths).size, 9);
  assert.ok(maximum > 1 && maximum <= 4, `observed concurrency ${maximum}`);
  console.log(JSON.stringify({ pages: paths.length, maximum, elapsedMsIncludingSwift: Date.now() - started }));
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
