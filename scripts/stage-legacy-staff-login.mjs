// Stage an existing bos-web member's password hash for the native web client.
// This never writes a live auth store. Activate only after exact-record approval.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function stageLogin(config, spaceId, username, now = Date.now()) {
  if (!/^[a-z0-9][a-z0-9._-]{1,39}$/.test(username)) throw new Error('invalid username');
  const space = config.spaces?.[spaceId];
  if (!space || space.public) throw new Error('private client space required');
  const matches = Object.entries(space.members ?? {}).filter(([, member]) => member.pass && member.name?.trim().toLowerCase() === username);
  if (matches.length !== 1) throw new Error('expected exactly one existing password member');
  const [key, member] = matches[0];
  const parts = member.pass.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt' || !parts[1] || !/^[a-f0-9]{64}$/i.test(parts[2])) throw new Error('unsupported legacy password hash');
  const phone = key.startsWith('wa:') ? key.slice(3) : undefined;
  if (!phone || !/^[1-9][0-9]{7,14}$/.test(phone)) throw new Error('expected existing international phone member');
  return { logins: [{ id: randomUUID(), name: member.name.trim(), username, phone, role: 'member', salt: Buffer.from(parts[1], 'utf8').toString('base64'), hash: Buffer.from(parts[2], 'hex').toString('base64'), createdAt: now, passwordSetAt: now }] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [configPath, spaceId, username, output] = process.argv.slice(2);
  if (!configPath || !output?.endsWith('.candidate.json')) throw new Error('usage: node stage-legacy-staff-login.mjs CONFIG SPACE USERNAME OUTPUT.candidate.json');
  const staged = stageLogin(JSON.parse(readFileSync(configPath, 'utf8')), spaceId, username);
  writeFileSync(output, JSON.stringify(staged, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ staged: true, space: spaceId, username, role: 'member', existingPasswordPreserved: true }));
}
