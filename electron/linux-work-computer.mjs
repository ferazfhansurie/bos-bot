// Trusted WSL terminal/files worker implementation for the existing transport.
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { executeSharedOperation } from './shared-computer-access.mjs';

export const linuxWorkHome = '/home/firaz';
export const linuxWorkBotIds = Object.freeze([
  'fa9834ee-ed6f-47a9-8760-070d1e32e9c3',
  '30253fee-292a-45ab-9c0f-6a7c0050dc84',
  'ab3fdfef-cb6d-41f2-93c4-b2d6cd2fc8fc',
]);
export const linuxProtectedPaths = [
  linuxWorkHome + '/.local/share/bos-work-computer',
  linuxWorkHome + '/.local/share/bos-server',
  linuxWorkHome + '/.bos-bot',
];
const namespaceScript = fileURLToPath(new URL('./linux-work-namespace.py', import.meta.url));

export async function validateLinuxWorkFolders(folders) {
  if (!Array.isArray(folders) || folders.length !== 1) throw new Error('Share exactly the granted Linux home');
  const folder = folders[0];
  if (folder?.path !== linuxWorkHome || folder.write !== true || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(folder.id ?? '')) throw new Error('Only read/write /home/firaz is granted');
  if (await fs.realpath(folder.path) !== linuxWorkHome || !(await fs.stat(folder.path)).isDirectory()) throw new Error('The granted Linux home is unavailable');
  return [{ id: folder.id, path: linuxWorkHome, name: 'firaz', write: true }];
}

export function namespaceCommand(command, signal, spawnImpl = spawn) {
  if (process.platform !== 'linux') throw new Error('Linux namespace unavailable; no local shell fallback');
  if (typeof command !== 'string' || !command.trim() || command.length > 8000) throw new Error('Give a command of at most 8000 characters');
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/python3', [namespaceScript, command], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: linuxWorkHome, LANG: 'C.UTF-8' },
    });
    let reason, bytes = 0;
    const chunks = [];
    const stop = message => {
      reason ??= message;
      if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }
    };
    const abort = () => stop('Computer access ended; outcome may be unknown. Inspect before retrying.');
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('Command timed out after 30 seconds; inspect before retrying.'), 30_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes <= 256 * 1024) chunks.push(chunk); else stop('Command output exceeded limit; inspect before retrying.');
    });
    child.once('error', error => { cleanup(); reject(error); });
    child.once('close', code => {
      cleanup();
      if (reason) reject(new Error(reason));
      else resolve({ content: [{ type: 'text', text: JSON.stringify({ exitCode: code, output: Buffer.concat(chunks).toString('utf8') }) }] });
    });
  });
}

export async function executeLinuxWorkOperation(grant, operation, signal) {
  if (grant.computer !== false || grant.terminal !== true || !Array.isArray(grant.allowedBotIds) ||
      grant.allowedBotIds.length !== linuxWorkBotIds.length || linuxWorkBotIds.some(id => !grant.allowedBotIds.includes(id))) {
    throw new Error('Worker grant does not match the three authorized bots');
  }
  await validateLinuxWorkFolders(grant.folders);
  if (operation.action === 'run_command') return namespaceCommand(operation.command, signal);
  if (!['list_files', 'read_file', 'write_file'].includes(operation.action)) throw new Error('Only Linux terminal and granted files are available');
  return executeSharedOperation({ ...grant, protectedPaths: [...linuxProtectedPaths, ...(grant.protectedPaths ?? [])] }, operation, signal, () => { throw new Error('Desktop access is not granted'); });
}
