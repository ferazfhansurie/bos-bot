// Real provider acceptance, explicitly confined to newly owned fixture data.
// No live URL, credential discovery/copying, native tools or model mocks.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePortBlock } from '../../server/testing/ports.ts';
import { removeTempDir, waitForExit } from '../../server/testing/cleanup.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const cli = resolve(args.includes('--cli') ? option('--cli') : '/Users/firazfhansurie/.local/bin/claude');
const mode = args.includes('--case') ? option('--case') : 'normal';
if (!['normal', 'human', 'stop'].includes(mode)) throw new Error('case must be normal, human or stop');
if (args.includes('--prepare-auth')) {
  const auth = mkdtempSync(join(tmpdir(), 'omb-real-model-auth-'));
  writeFileSync(join(auth, '.omb-fixture-auth'), 'isolated fixture auth; never copy credentials here\n', { mode: 0o600 });
  console.log(JSON.stringify({ fixtureAuthDir: auth, next: 'authenticate with the native CLI using this CLAUDE_CONFIG_DIR; then pass --auth-dir and --run' }));
  process.exit(0);
}
const home = mkdtempSync(join(tmpdir(), 'omb-real-continuity-'));
let auth = join(home, 'provider');
if (args.includes('--auth-dir')) {
  auth = resolve(option('--auth-dir'));
  if (auth !== realpathSync(auth) || !existsSync(join(auth, '.omb-fixture-auth'))) {
    throw new Error('auth-dir must be a non-symlink fixture directory made by --prepare-auth');
  }
}
mkdirSync(auth, { recursive: true });
mkdirSync(join(home, 'tmp'));
const env: NodeJS.ProcessEnv = {
  HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: auth,
  XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
  XDG_DATA_HOME: join(home, '.local', 'share'), TMPDIR: join(home, 'tmp'),
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  OMB_DATA_DIR: home, OMB_DISABLE_LEGACY_MIGRATION: '1',
};
const output = resolve(args.includes('--output') ? option('--output') : join(root, 'docs/verification/v18-real-model-evidence.json'));
const evidence: any = { fixtureOnly: true, providerKind: 'real-cli', modelDispatched: false, case: mode, accepted: false, observations: [], remaining: [] };
const jsonFile = (file: string) => { try { return JSON.parse(readFileSync(join(home, file), 'utf8')); } catch { return []; } };
const redact = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/(?:sk-|sk-ant-)[A-Za-z0-9_-]+/g, '[redacted]');
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !/token|secret|credential|authorization|mcpConfig|environment/i.test(key)).map(([key, v]) => [key, redact(v)]));
  return value;
};
let child: ReturnType<typeof spawn> | undefined;
let base = '';
let created: any[] = [];
const api = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`);
  return data;
};
const pause = () => new Promise(r => setTimeout(r, 250));
const until = async (check: () => Promise<boolean> | boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) throw new Error('bounded fixture deadline exceeded'); await pause(); }
};
try {
  const status = spawnSync(cli, ['auth', 'status', '--json'], { cwd: home, env, encoding: 'utf8', timeout: 20000 });
  let loggedIn = false;
  try { loggedIn = JSON.parse(status.stdout).loggedIn === true; } catch { /* fail closed */ }
  evidence.auth = { exitCode: status.status, loggedIn };
  if (!loggedIn) {
    evidence.remaining.push('native provider sign-in in an isolated fixture config; no model was dispatched');
    process.exitCode = 2;
  } else if (!args.includes('--run')) {
    evidence.remaining.push('preflight only; run each acceptance case with --run');
  } else {
    const port = await freePortBlock([0, 1]);
    base = `http://127.0.0.1:${port}`;
    writeFileSync(join(home, 'config.json'), JSON.stringify({ instances: { real: { driver: 'claudeAgent', displayName: 'Isolated real Claude', config: { cli, configDir: auth, tools: [] } } } }));
    child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, env: { ...env, OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(port + 1) }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Logs can include capability-bearing data. Drain without retaining them.
    child.stdout!.resume(); child.stderr!.resume();
    await until(async () => {
      if (child!.exitCode !== null) throw new Error('owned fixture server exited');
      try { return (await fetch(base + '/api/health')).ok; } catch { return false; }
    }, 20000);
    const instances = (await api('GET', '/api/instances')).instances;
    const real = instances.find((i: any) => i.instanceId === 'real');
    if (!real || real.snapshot.state !== 'available') throw new Error('real provider instance unavailable');
    evidence.provider = { instanceId: 'real', version: real.snapshot.version, model: real.models.default };
    for (const [name, description] of [
      ['Fixture Lead', 'Accountable calculator and evidence verifier'],
      ['Fixture Numeric Auditor', 'Independent arithmetic and rounding audit'],
      ['Fixture Copy Editor', 'Prose readability only; no numerical audit specialty'],
    ]) {
      const bot = (await api('POST', '/api/bots', {})).bot;
      created.push((await api('PATCH', `/api/bots/${bot.id}`, { name, description, approvalMode: 'full', cwd: home, modelSelection: { instanceId: 'real', model: real.models.default }, ...(name === 'Fixture Lead' ? { workContinuity: true } : {}) })).bot);
    }
    const lead = created[0];
    evidence.leadThread = lead.threadId;
    const prompt = mode === 'normal'
      ? 'Synthetic job only: calculate revenue, total units and weighted mean unit price for 12 units at 19, 7 at 25, and 3 at 40. Choose a useful independent helper from the available roster and actually dispatch its audit through update_work_plan(send_assignments=true). Do substantive calculation yourself while its audit runs. Record a ready own verification step, then end this first turn at a checkpoint so automatic same-thread continuation must perform that step. On continuation reconcile the helper evidence, verify arithmetic, and record completion only when supported. Do not open threads, use native tools, or message anyone outside these synthetic peers.'
      : mode === 'human'
        ? 'Synthetic job only: compute 12*19+7*25+3*40 yourself. Record that substantive step done with evidence, then a ready step owned by human for final physical-device acceptance. Leave the plan unfinished and end. No helper has independent authorized work. Never perform or mark the human step done.'
        : 'Synthetic job only: compute the weighted mean for 12 at 19, 7 at 25, 3 at 40. Before calculating, record a plan with a ready own calculation step. Do not dispatch helpers; no independent helper work is authorized. This fixture will send Stop as soon as the plan is recorded.';
    await api('POST', `/api/bots/${lead.id}/messages`, { text: prompt, threadId: lead.threadId });
    evidence.modelDispatched = true;
    if (mode === 'stop') {
      await until(() => jsonFile('work-plans.json').some((p: any) => p.botId === lead.id), 180000);
      await api('POST', `/api/bots/${lead.id}/interrupt`, {});
      evidence.observations.push('Stop submitted after actual model-created plan');
    }
    let quiet = 0;
    await until(async () => {
      const bots = (await api('GET', '/api/bots?messages=0')).bots.filter((b: any) => created.some(c => c.id === b.id));
      if (bots.some((b: any) => b.busy)) { quiet = 0; return false; }
      return ++quiet >= 20; // bounded quiet window includes queued result/continuation settlement
    }, 240000);
    evidence.plans = jsonFile('work-plans.json');
    evidence.runtime = jsonFile('work-runtime.json');
    evidence.handoffs = jsonFile('room-handoffs.json');
    evidence.bots = [];
    for (const bot of created) {
      const state = (await api('GET', '/api/bots?messages=0')).bots.find((b: any) => b.id === bot.id);
      const transcript = (await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`)).messages;
      let terminals: any[] = [];
      try {
        terminals = readFileSync(join(home, 'events', `${bot.threadId}.ndjson`), 'utf8').trim().split('\n')
          .map(line => JSON.parse(line)).filter(e => ['turn.started', 'turn.completed'].includes(e.type))
          .map(({ type, threadId, turnId, ok, stopReason }) => ({ type, threadId, turnId, ok, stopReason }));
      } catch { /* no provider dispatch must remain visible */ }
      evidence.bots.push({ id: bot.id, name: bot.name, threadId: bot.threadId, tasks: state?.tasks, transcript, terminals,
        dispatchCount: terminals.filter(e => e.type === 'turn.started').length });
    }
    evidence.remaining.push('independent transcript review: useful helper choice, substantive lead arithmetic, same-thread dispatch provenance, continuation budget, Stop/human holds; script never auto-approves model claims');
  }
} catch (error) {
  evidence.remaining.push(error instanceof Error ? error.message : 'fixture failed');
  process.exitCode = 1;
} finally {
  if (child) {
    // Even a failed/timed-out model run must retain partial observed facts.
    evidence.plans = jsonFile('work-plans.json');
    evidence.runtime = jsonFile('work-runtime.json');
    evidence.handoffs = jsonFile('room-handoffs.json');
    if (!evidence.bots) {
      evidence.bots = [];
      for (const bot of created) {
        const transcript = await api('GET', `/api/threads/${bot.threadId}/messages?limit=100`).catch(() => ({ messages: [] }));
        evidence.bots.push({ id: bot.id, name: bot.name, threadId: bot.threadId, transcript: transcript.messages });
      }
    }
    for (const bot of created) await api('POST', `/api/bots/${bot.id}/interrupt`, {}).catch(() => undefined);
    await waitForExit(child, { signal: 'SIGTERM' });
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(redact(evidence), null, 2) + '\n', { mode: 0o600 });
  await removeTempDir(home);
  console.log(JSON.stringify({ evidence: output, accepted: false, auth: evidence.auth, remaining: evidence.remaining }));
}
