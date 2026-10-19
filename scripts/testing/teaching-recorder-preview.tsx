// Fixture only: synthetic canvas video, never a user's screen or microphone.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { StoreProvider, useStore } from '../../src/state/store';
import { TeachingRecorder } from '../../src/components/bot-settings/TeachingRecorder';
import '../../src/styles.css';
const proof = { streams: [] as MediaStream[], stopped: 0, uploads: 0, hold: false, release: () => {}, setThread: () => {} };
Object.assign(window, { teachingFixture: proof });
Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { configurable: true, value: async () => {
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#134e4a'; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = 'white'; ctx.font = '24px sans-serif'; ctx.fillText('synthetic teaching step', 50, 150);
  const stream = canvas.captureStream(1); proof.streams.push(stream);
  for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { proof.stopped++; stop(); }; }
  return stream;
} });
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  if (String(input).startsWith('/api/attachments?')) { proof.uploads++; if (proof.hold) await new Promise<void>(resolve => { proof.release = () => { proof.hold = false; resolve(); }; }); }
  return originalFetch(input, init);
};
function Preview() {
  const { state } = useStore();
  const [thread, setThread] = useState(new URLSearchParams(location.search).get('thread') ?? '');
  proof.setThread = setThread;
  const bot = state.bots[0];
  return <><output id="ready">{String(state.connected && !!bot)}</output>{bot && <TeachingRecorder key={bot.id} bot={{ ...bot, threadId: thread || bot.threadId }} />}</>;
}
createRoot(document.getElementById('root')!).render(<StoreProvider><Preview /></StoreProvider>);
