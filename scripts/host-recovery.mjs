#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createHostRecovery } from '../electron/host-recovery.mjs';

if (process.argv.length !== 4 || process.argv[2] !== '--config') throw new Error('usage: node scripts/host-recovery.mjs --config /absolute/private-config.json');
const owner = createHostRecovery(JSON.parse(readFileSync(process.argv[3], 'utf8')));
let last;
const tick = () => {
  try {
    const result = owner.tick();
    const status = JSON.stringify(result);
    if (status !== last) { console.log(status); last = status; }
  } catch (error) { console.error(`recovery held: ${error.message}`); }
};
tick();
const timer = setInterval(tick, 1_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { clearInterval(timer); owner.close(); });
