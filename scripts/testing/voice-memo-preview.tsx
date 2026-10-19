// Disposable control-omb ui entry. No microphone, provider or user files.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { api } from "../../src/state/store";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

setAnalyticsEnabled(false); setEmailGateDone("skipped"); applySkin(readSkin());
function wave(): Uint8Array<ArrayBuffer> {
  const samples = 8000 * 5;
  const result = new Uint8Array(44 + samples * 2);
  const view = new DataView(result.buffer);
  const ascii = (at: number, value: string) => [...value].forEach((c, index) => view.setUint8(at + index, c.charCodeAt(0)));
  ascii(0, "RIFF"); view.setUint32(4, result.length - 8, true); ascii(8, "WAVE"); ascii(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, Math.sin(i * Math.PI * 2 * 220 / 8000) * 2000, true);
  return result;
}
async function upload(bytes: BodyInit, mime: string): Promise<string> {
  const response = await fetch(`/api/files?name=fixture.${mime === "audio/wav" ? "wav" : mime === "text/vtt" ? "vtt" : "txt"}`, { method: "POST", headers: { "content-type": mime }, body: bytes });
  if (!response.ok) throw new Error(`fixture upload failed: ${response.status}`);
  return (await response.json()).path;
}
const { bots } = await api("/api/bots?messages=0");
const bot = bots.find((candidate: { name: string }) => candidate.name === "Pepper");
if (!bot) throw new Error("fixture Pepper missing");
const audio = await upload(wave(), "audio/wav");
const untimedAudio = await upload(wave(), "audio/wav");
const timed = await upload("WEBVTT\n\n00:00.000 --> 00:01.000\nfirst thought\n\n00:02.000 --> 00:04.500\nsecond thought", "text/vtt");
const plain = await upload("an untimed transcript stays readable without invented timing", "text/plain");
await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: JSON.stringify({ text: `review these synthetic memos\n<attached-file path="${audio}" name="memo.wav" />\n<attached-file path="${timed}" name="memo.vtt" />\n<attached-file path="${untimedAudio}" name="untimed.wav" />\n<attached-file path="${plain}" name="untimed.txt" />` }) });
createRoot(document.getElementById("root")!).render(<App />);
