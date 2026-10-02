// Disposable server, fake model, real pairing + authenticated MCP + rendezvous.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it, vi } from 'vitest';
import { launchVerificationServer } from '../scripts/control-omb.ts';

it('pins native-disabled turns to authenticated transport and refuses offline work before provider dispatch', async () => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: 'hang' });
  let proxy: ChildProcess | undefined;
  const api = async (method: string, route: string, body?: unknown, headers = {}) => {
    const response = await fetch(fixture.info.url + route, { method, headers: { 'content-type': 'application/json', origin: fixture.info.url, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  try {
    expect((await api('PATCH', '/api/config', { features: { sharedComputers: true } })).status).toBe(200);
    const bot = (await api('POST', '/api/bots', { name: 'Pinned fixture' })).body.bot;
    const offlineBot = (await api('POST', '/api/bots', { name: 'Offline fixture' })).body.bot;
    const pairing = (await api('POST', '/api/auth/pairing', { scopes: ['client'] })).body;
    const paired = (await api('POST', '/api/auth/pair', { code: pairing.code })).body;
    const secret = 'b'.repeat(64);
    const headers = { authorization: `Bearer ${paired.token}`, 'x-omb-computer-secret': secret };
    const computer = { id: randomUUID(), name: 'Fixture laptop', environmentId: paired.environment.environmentId, folders: [], terminal: true, computer: false, allowedBotIds: [bot.id, offlineBot.id] };
    expect((await api('POST', '/api/shared-computers/connect', computer, headers)).status).toBe(200);
    for (const target of [bot, offlineBot]) expect((await api('PATCH', `/api/bots/${target.id}`, { sharedWorkComputer: { id: computer.id, name: computer.name } })).status).toBe(200);
    expect((await api('POST', `/api/bots/${bot.id}/messages`, { text: 'Read hostname on the saved work computer.' })).status).toBe(202);
    const dump = join(fixture.info.dataDir, 'fake-claude-dump.json');
    await vi.waitFor(() => expect(existsSync(dump)).toBe(true), { timeout: 15_000 });
    const snapshot = JSON.parse(readFileSync(dump, 'utf8'));
    expect(snapshot.argv[snapshot.argv.indexOf('--tools') + 1]).toBe('');
    expect(snapshot.argv).toContain('--strict-mcp-config');
    expect(snapshot.argv[snapshot.argv.indexOf('--setting-sources') + 1]).toBe('');
    const agents = snapshot.mcpConfig.mcpServers.agents;
    proxy = spawn(agents.command, agents.args, { env: { PATH: process.env.PATH, HOME: fixture.info.dataDir, ...agents.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let sequence = 0;
    const pending = new Map<number, (value: any) => void>();
    createInterface({ input: proxy.stdout! }).on('line', line => { const value = JSON.parse(line); pending.get(value.id)?.(value); pending.delete(value.id); });
    const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Fixture MCP timeout')); }, 10_000);
      pending.set(id, value => { clearTimeout(timer); resolve(value.result); });
      proxy!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    await rpc('initialize', { protocolVersion: '2024-11-05' });
    const operation = () => rpc('tools/call', { name: 'shared_computer', arguments: { computer_id: computer.id, action: 'run_command', command: 'hostname' } });
    const result = operation();
    const job = (await api('POST', `/api/shared-computers/${computer.id}/poll`, {}, headers)).body.job;
    expect(job.operation.command).toBe('hostname');
    await api('POST', `/api/shared-computers/${computer.id}/result`, { jobId: job.id, result: { content: [{ type: 'text', text: JSON.stringify({ exitCode: 0, output: 'fixture-laptop\n' }) }] } }, headers);
    expect((await result).content[0].text).toContain('fixture-laptop');
    const wrong = await rpc('tools/call', { name: 'shared_computer', arguments: { computer_id: randomUUID(), action: 'run_command', command: 'hostname' } });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toContain('another computer');
    expect((await api('POST', `/api/shared-computers/${computer.id}/disconnect`, {}, headers)).status).toBe(200);
    expect((await operation()).isError).toBe(true);
    const before = readFileSync(dump, 'utf8');
    const stopped = await api('POST', `/api/bots/${offlineBot.id}/messages`, { text: 'Run hostname.' });
    expect(stopped.status).toBe(409);
    expect(stopped.body.error).toContain('offline');
    expect(readFileSync(dump, 'utf8')).toBe(before);
  } finally { proxy?.kill(); await fixture.close(); }
}, 45_000);
