import { expect, it } from 'vitest';
it('starts test modules without inherited bot tool authority', () => {
 const leaked = Object.keys(process.env).filter(key => /^(?:BOSBOT_|BOS_|OMB_|OPENMAUSBOT_|AIOS_)/.test(key) && /(?:HARNESS_URL|COMMS_TOKEN|BOT_ID|THREAD_ID|TURN_GENERATION)$/.test(key));
 expect(leaked).toEqual([]);
});
