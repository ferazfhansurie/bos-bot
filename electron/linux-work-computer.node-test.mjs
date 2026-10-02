import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeLinuxWorkOperation, validateLinuxWorkFolders, linuxWorkBotIds, linuxWorkHome } from './linux-work-computer.mjs';

test('Linux worker refuses broader folders, read-only grants and malformed folder IDs', async () => {
  const id = '134b9a68-9d6d-4653-915a-8e63a03d27f4';
  for (const folders of [[], [{ id, path: '/mnt/c', write: true }], [{ id, path: linuxWorkHome, write: false }], [{ id: '-'.repeat(36), path: linuxWorkHome, write: true }], [{ id, path: linuxWorkHome, write: true }, { id, path: '/tmp', write: true }]]) {
    await assert.rejects(validateLinuxWorkFolders(folders));
  }
});
test('Linux worker refuses screen and altered bot allowlists before opening files', async () => {
  const grant = { terminal: true, computer: false, allowedBotIds: linuxWorkBotIds, folders: [] };
  for (const mutation of [{ computer: true }, { terminal: false }, { allowedBotIds: [] }, { allowedBotIds: [...linuxWorkBotIds, 'intruder'] }, { allowedBotIds: [linuxWorkBotIds[0], linuxWorkBotIds[0], linuxWorkBotIds[1]] }]) {
    await assert.rejects(executeLinuxWorkOperation({ ...grant, ...mutation }, { action: 'read_file' }, new AbortController().signal), /three authorized bots/);
  }
});
