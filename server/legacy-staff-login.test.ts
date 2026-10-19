import { scryptSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { PasswordLogins } from './password-signin.ts';
import { stageLogin } from '../scripts/stage-legacy-staff-login.mjs';
import { removeTempDir } from './testing/cleanup.ts';

it('preserves the legacy password and phone while granting only member access', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'bos-staff-migration-'));
 try {
  const password = 'synthetic-fixture-password';
  const salt = 'legacy-utf8-salt';
  const hash = scryptSync(password, salt, 32).toString('hex');
  const staged = stageLogin({spaces:{clinic:{members:{'wa:60123456789':{name:'uteh',pass:`scrypt$${salt}$${hash}`,role:'admin'}}}}},'clinic','uteh');
  const file=join(dir,'password-logins.json');
  writeFileSync(file,JSON.stringify(staged),{mode:0o600});
  const native = new PasswordLogins(file);
  expect(native.verify('uteh',password)).toMatchObject({username:'uteh',role:'member',phone:'60123456789'});
  expect(native.verify('012-345 6789',password)?.username).toBe('uteh');
  expect(native.verify('uteh','wrong')).toBeNull();
  expect(() => stageLogin({spaces:{clinic:{public:true}}},'clinic','uteh')).toThrow();
  expect(() => stageLogin({spaces:{clinic:{members:{}}}},'clinic','uteh')).toThrow();
 } finally { await removeTempDir(dir); }
});
