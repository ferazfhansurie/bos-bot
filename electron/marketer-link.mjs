import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { PACKAGE_SCHEMES } from './release-channel.mjs';

/** Public offer intent only: no lead, identity, account, grant or payment token. */
export function isMarketerLink(raw) {
  try {
    const url = new URL(String(raw));
    return PACKAGE_SCHEMES.includes(url.protocol.slice(0, -1)) && url.hostname === 'offer'
      && url.pathname === '/digital-marketer' && !url.search && !url.hash
      && !url.username && !url.password && !url.port;
  } catch { return false; }
}

export function marketerIntentStore(directory, now = Date.now) {
  const file = join(directory, 'marketer-offer-intent.json');
  return {
    pending() {
      try {
        const raw = readFileSync(file, 'utf8');
        if (raw.length > 256) return false;
        const record = JSON.parse(raw);
        return record.offer === 'digital-marketer' && Number.isFinite(record.expiresAt)
          && record.expiresAt > now() && record.expiresAt <= now() + 7 * 86_400_000;
      } catch { return false; }
    },
    remember() {
      mkdirSync(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify({ offer: 'digital-marketer', expiresAt: now() + 7 * 86_400_000 }), { mode: 0o600 });
      renameSync(temporary, file);
    },
    clear() { rmSync(file, { force: true }); },
  };
}
