#!/usr/bin/env node
// Headless owner connector. Uses existing workspace pairing + shared-computer
// rendezvous; it never moves AI turns or accepts remote grant changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createComputerSharing } from './computer-sharing.mjs';
import { executeLinuxWorkOperation, validateLinuxWorkFolders, namespaceCommand, linuxProtectedPaths, linuxWorkBotIds, linuxWorkHome } from './linux-work-computer.mjs';

const directory = linuxWorkHome + '/.local/share/bos-work-computer';
const configFile = directory + '/worker.json';
const grantFile = directory + '/grants.json';

async function privateDirectory() {
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Worker paths must not be symlinks'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}
async function loadConfig() {
  const stat = await fs.lstat(configFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Worker credential file must be private and owned by this user');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const origin = new URL(config.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || typeof config.token !== 'string' || !config.token || typeof config.envId !== 'string') throw new Error('Invalid paired worker configuration');
  return config;
}
function connector(config) {
  const env = { id: config.envId, origin: config.origin };
  const client = createComputerSharing({
    file: grantFile, environments: () => [env], enabled: async () => true,
    protectedPaths: linuxProtectedPaths, validateFolders: validateLinuxWorkFolders,
    executeOperation: executeLinuxWorkOperation,
    retryPolicy: { maxFailures: 6, initialDelayMs: 1000, maxDelayMs: 30_000 },
    fetch: (url, options) => {
      if (new URL(url).origin !== new URL(config.origin).origin) throw new Error('Worker destination changed');
      return fetch(url, { ...options, headers: { ...options.headers, authorization: `Bearer ${config.token}` } });
    },
    cuaConnection: async () => { throw new Error('Screen access is not granted'); },
    hostControl: async () => { throw new Error('Screen access is not granted'); },
  });
  return { env, client };
}

async function main() {
  if (process.platform !== 'linux' || Number(process.versions.node.split('.')[0]) < 20) throw new Error('This worker requires Linux and Node 20+');
  await privateDirectory();
  await namespaceCommand('true', new AbortController().signal);
  if (process.argv[2] === '--pair') {
    if (process.argv.length !== 4) throw new Error('Provide the verified HTTPS workspace origin');
    try { await fs.lstat(configFile); throw new Error('Worker already paired; inspect existing owner before replacing it'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const origin = new URL(process.argv[3]);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Pairing requires the verified HTTPS workspace origin');
    // Code arrives on stdin from the owner pairing flow. Never argv/log/chat.
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 4096) throw new Error('Pairing input too large'); }
    const { code } = JSON.parse(input);
    if (typeof code !== 'string' || !code) throw new Error('Owner pairing code required');
    const response = await fetch(new URL('/api/auth/pair', origin), {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label: 'bos-laptop Linux work computer', attemptId: randomUUID() }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Owner pairing refused (${response.status}); no retry`);
    const paired = await response.json();
    if (!paired.token || !paired.environment?.environmentId) throw new Error('Pairing response invalid; inspect before retrying');
    const config = { origin: origin.origin, token: paired.token, envId: paired.environment.environmentId };
    await fs.writeFile(configFile + '.tmp', JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    await fs.rename(configFile + '.tmp', configFile);
    const { env, client } = connector(config);
    try {
      const info = await client.identity(env);
      await client.save(env, { folders: [{ id: randomUUID(), path: linuxWorkHome, write: true }], terminal: true, computer: false, allowedBotIds: linuxWorkBotIds }, info, { activate: false });
    } finally { client.close(); }
    console.log('Owner pairing and scoped grant saved. Worker is not running.');
    return;
  }
  if (process.argv[2] !== '--run' || process.argv.length !== 3) throw new Error('Use --pair <origin> or --run');
  const config = await loadConfig();
  const saved = JSON.parse(await fs.readFile(grantFile, 'utf8')).records?.[config.envId];
  if (!saved?.enabled || saved.computer !== false || saved.terminal !== true || saved.allowedBotIds?.length !== linuxWorkBotIds.length || linuxWorkBotIds.some(id => !saved.allowedBotIds.includes(id))) throw new Error('Saved worker grant is unavailable; no registration');
  await validateLinuxWorkFolders(saved.folders);
  const lock = directory + '/owner.lock';
  await fs.mkdir(lock, { mode: 0o700 }); // stale lock requires manual inspection
  await fs.writeFile(lock + '/pid', String(process.pid), { mode: 0o600 });
  const { env, client } = connector(config);
  let timer;
  const close = async () => { clearInterval(timer); client.close(); await fs.rm(lock, { recursive: true }); };
  process.once('SIGTERM', () => { void close().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void close().then(() => process.exit(0)); });
  client.start();
  let previous;
  timer = setInterval(() => {
    const state = client.state(env.id);
    const safe = JSON.stringify({ connected: state.connected === true, circuitOpen: state.circuitOpen === true, error: state.error });
    if (safe !== previous) { console.log(safe); previous = safe; }
    if (state.circuitOpen) void close().then(() => process.exit(1));
  }, 1000);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
