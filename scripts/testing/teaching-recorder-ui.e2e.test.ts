import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { closeBrowserSession } from '../../server/browser-engine.ts';
import { launchVerificationServer, runControlOmb } from '../control-omb.ts';
import { ensureUiBrowser, sessionEnv } from './control-omb-ui.ts';
import { mountPreview, fixtureApi, type MountedPreview } from './preview-fixture.ts';
const exec = promisify(execFile);
it('records synthetic steps, reviews notes, sends to its pinned thread and stops discarded capture tracks', async () => {
  const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BOSBOT_|BOS_|OMB_|OPENMAUSBOT_|AIOS_)/.test(key)));
  const { binary, chrome } = await ensureUiBrowser();
  const fixture = await launchVerificationServer(safeEnv, undefined, undefined, { binaryPath: binary, executablePath: chrome ?? '' });
  const env = sessionEnv({ home: fixture.info.dataDir, session: `teaching-fixture-${new URL(fixture.info.url).port}`, chrome });
  let preview: MountedPreview | undefined;
  const browser = async (...args: string[]) => {
    const { stdout } = await exec(binary, [...args, '--json'], { env, timeout: 30_000, maxBuffer: 2_000_000 });
    const result = JSON.parse(stdout); expect(result.success, stdout).toBe(true); return result.data;
  };
  const evaluate = async (js: string) => (await browser('eval', js)).result;
  const click = async (text: string) => { await expect.poll(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(text)} && !b.disabled)`), { timeout: 15_000 }).toBe(true); return evaluate(`(() => { const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button || button.disabled) throw new Error('button unavailable'); button.click(); return true; })()`); };
  const fill = (label: string, text: string) => evaluate(`(() => { const field = document.querySelector('[aria-label=${JSON.stringify(label)}]'); const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, ${JSON.stringify(text)}); field.dispatchEvent(new Event('input', {bubbles:true})); return field.value; })()`);
  const api = fixtureApi(fixture.info.url);
  const proof: unknown[] = [];
  try {
    const { bot } = await runControlOmb(['new-bot', '--name', 'Teaching fixture', '--url', fixture.info.url], { env: safeEnv }) as any;
    const initialThread = (await api('GET', '/api/bots')).bots.find((b: any) => b.id === bot.id).threadId;
    const { task } = await api('POST', `/api/bots/${bot.id}/tasks`, { title: 'Different thread' });
    preview = await mountPreview(fixture, { entry: '/scripts/testing/teaching-recorder-preview.tsx', route: '/__teaching.html', title: 'Synthetic teaching recorder', logLevel: 'warn' });
    await browser('open', preview.previewUrl + '?thread=' + initialThread);
    await browser('wait', '--fn', 'document.querySelector("#ready")?.textContent === "true"');
    await fill('task to teach', 'review a synthetic receipt'); await click('start recording');
    await browser('wait', '--fn', 'document.querySelector("video")?.videoWidth > 0');
    await click('capture step');
    await expect.poll(() => evaluate('document.querySelectorAll("img").length')).toBe(1);
    await fill('step 1 note', 'open the synthetic receipt'); await click('stop and review');
    expect(await evaluate('window.teachingFixture.streams[0].getTracks().every(t => t.readyState === "ended")')).toBe(true);
    await browser('screenshot', fixture.info.logPath + '.teaching-review.png');
    await evaluate('window.teachingFixture.hold = true'); await click('learn from reviewed demonstration');
    await expect.poll(() => evaluate('window.teachingFixture.uploads')).toBe(1);
    // A later displayed task must not redirect an already reviewed send.
    await evaluate(`window.teachingFixture.setThread(${JSON.stringify(task.threadId)})`);
    await evaluate('window.teachingFixture.release()');
    const messages = async (thread: string) => (await api('GET', `/api/threads/${thread}/messages?limit=100`)).messages;
    await expect.poll(async () => (await messages(initialThread)).some((m: any) => m.role === 'user' && m.text?.includes('reviewed demonstration')), { timeout: 15_000 }).toBe(true);
    const sent = (await messages(initialThread)).find((m: any) => m.role === 'user' && m.text?.includes('reviewed demonstration'));
    expect(sent.text).toContain('open the synthetic receipt'); expect(sent.text).toContain('do not execute'); expect(sent.text).toContain('demonstration-1');
    expect((await messages(task.threadId)).filter((m: any) => m.role === 'user')).toHaveLength(0);
    proof.push({ initialThread, alternateThread: task.threadId, userMessageId: sent.id, text: sent.text });
    // A fresh mount verifies discard without leaving screen capture running.
    await browser('open', preview.previewUrl + '?thread=' + task.threadId);
    await browser('wait', '--fn', 'document.querySelector("#ready")?.textContent === "true"');
    await fill('task to teach', 'discard this synthetic capture'); await click('start recording');
    await browser('wait', '--fn', 'document.querySelector("video")?.videoWidth > 0'); await click('capture step');
    await expect.poll(() => evaluate('document.querySelectorAll("img").length')).toBe(1);
    await click('discard recording');
    expect(await evaluate('window.teachingFixture.streams.every(s => s.getTracks().every(t => t.readyState === "ended"))')).toBe(true);
    expect(await evaluate('document.querySelectorAll("img").length')).toBe(0);
    expect(await evaluate('window.teachingFixture.uploads')).toBe(0);
    proof.push({ discarded: true, allTracksStopped: true, uploads: 0 });
  } finally {
    await closeBrowserSession(binary, env); await preview?.close(); await fixture.close();
    const evidencePath = fixture.info.logPath + '.teaching-proof.json'; writeFileSync(evidencePath, JSON.stringify(proof, null, 2)); console.info(JSON.stringify({ evidencePath }));
  }
}, 120_000);
