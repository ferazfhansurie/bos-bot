// A whitelist-only synthetic asset backend. No production API or engine connection.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";
const screenshot = readFileSync(fileURLToPath(new URL("../docs/verification/evidence/chat-ui/chat-ui.png", import.meta.url)));
const second = readFileSync(fileURLToPath(new URL("../docs/screenshots/docs-automations.png", import.meta.url)));
const video = readFileSync(process.env.BOS_CHAT_FIXTURE_VIDEO || fileURLToPath(new URL("../docs/screenshots/composer-dock-after.mp4", import.meta.url)));
// Five seconds of quiet PCM tone, generated in memory for this fixture only.
const audio = Buffer.alloc(44 + 8000 * 5 * 2);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
for (let i = 0; i < 40000; i++) audio.writeInt16LE(Math.round(Math.sin(i * Math.PI * 440 / 8000) * 1200), 44 + i * 2);
const stream = "BT /F1 18 Tf 40 100 Td (Synthetic PDF fixture) Tj ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 160] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = "%PDF-1.4\n"; const offsets = [0];
for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n ").join("\n")}\ntrailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
// Minimal deterministic OOXML package: content types, package relationships and one paragraph.
const document = Buffer.from("UEsDBBQAAAAIAAAAUF3mdcR+0gAAAIsBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QvVLDMAzHX8XnlasVGBh6SToAKzD0BXSOkvjw11luad++Sls6cIVR+n/8ZLebQ/BqT4Vdip1+NI3e9O32mImVKJE7Pdea1wBsZwrIJmWKooypBKwylgky2i+cCJ6a5hlsipViXdWlQ/ftK42481W9HWR9oRTyrNXLxbiwOo05e2exig77OPyirK4EI8mzh2eX+UEMGu4SFuVvwDX3Ic8ubiD1iaW+YxAXfKcywJDsLkjS/F9z5840js7SLb+05ZIsMbs4BW9uSkAXf+6H83f3J1BLAwQUAAAACAAAAFBdXzOVUpUAAAAHAQAACwAAAF9yZWxzLy5yZWxzjc87DsIwDAbgq0Q+QJ0yMKCmXVi6Ii4QJW5T0TzkhNftycBAEQOjf//6LHfDw6/iRpyXGBS0jYSh70606lKD7JaURW2ErMCVkg6I2TjyOjcxUaibKbLXpY48Y9LmomfCnZR75E8DtqYYrQIebQvi/Ez0jx2naTF0jObqKZQfJ74aVdY8U1Fwj2zRvuOmsoB9h5sX+xdQSwMEFAAAAAgAAABQXciml+CgAAAA3wAAABEAAAB3b3JkL2RvY3VtZW50LnhtbEWOSw7DIAxEr4I4AKRddBHlc4OqUk9AwUmQAkbGaZLbN6RSu3mWZ+QZN/0WZvEGyh5jKy+qkn3XrLVDuwSILA475npt5cScaq2znSCYrDBBPLwBKRg+Vhr1iuQSoYWcfRzDrK9VddPB+ChL5AvdXmYqoALunnvkCdhb8Ssc/MYLgRJ3FHbJjAFIOMNGNbqcFNLJMyiD5QfpU/g26P/33QdQSwECFAMUAAAACAAAAFBd5nXEftIAAACLAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAAAAUF1fM5VSlQAAAAcBAAALAAAAAAAAAAAAAACAAQMBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAAAAUF3IppfgoAAAAN8AAAARAAAAAAAAAAAAAACAAcEBAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAACQAgAAAAA=", "base64");
const assets = new Map<string, [string, string | Buffer]>([
  ["/fixture/demo.mp4", ["video/mp4", video]],
  ["/fixture/demo.webm", ["video/webm", video]],
  ["/fixture/audio.wav", ["audio/wav", audio]],
  ["/fixture/report.pdf", ["application/pdf", pdf]],
  ["/fixture/brief.docx", ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", document]],
  ["/fixture/preview.html", ["text/html", "<!doctype html><title>Synthetic preview</title><h1>Fixture artifact</h1>"]],
]);
const backend = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://fixture.invalid").pathname;
  if (path === "/api/bots/synthetic/threads/synthetic/messages/digest/diff" && req.method === "GET") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ patch: "diff --git a/src/styles.css b/src/styles.css\n--- a/src/styles.css\n+++ b/src/styles.css\n@@ -1 +1 @@\n-.assistant { max-width: 78%; }\n+.assistant { width: 100%; }\n", truncated: false })); return;
  }
  if (path === "/api/attachments/fixture-loading.png") {
    // Bounded delayed failure keeps loading visible in a capture.
    const timer = setTimeout(() => { res.writeHead(404); res.end(); }, 12000);
    res.on("close", () => clearTimeout(timer));
    return;
  }
  if (/^\/api\/attachments\/(?:fixture-(?:one|two)|gallery-[1-5])\.png$/.test(path)) {
    res.setHeader("content-type", "image/png"); res.end(path.includes("two") ? second : screenshot); return;
  }
  if (path === "/api/threads/synthetic/messages/showcase/file" && req.method === "POST") {
    let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 4096) { res.writeHead(413); res.end(); return; } }
    const asset = assets.get(JSON.parse(body).path);
    if (asset) { res.setHeader("content-type", asset[0]); res.end(asset[1]); return; }
  }
  if (path === "/api/bots/synthetic/checkpoints/restore" && req.method === "POST") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ synthetic: true })); return; }
  res.setHeader("content-type", "application/json");
  res.writeHead(404); res.end(JSON.stringify({ error: "Synthetic fixture: asset unavailable" }));
});
await new Promise<void>(resolve => backend.listen(0, "127.0.0.1", resolve));
const address = backend.address();
if (!address || typeof address === "string") throw new Error("fixture address missing");
const ui = await mountPreview({ info: { url: `http://127.0.0.1:${address.port}` } }, { entry: "/scripts/testing/chatgpt-chat-preview.tsx", route: "/__chatgpt-chat.html", title: "Synthetic chat renderer fixture", logLevel: "error" });
console.log(JSON.stringify({ previewUrl: ui.previewUrl, synthetic: true, liveData: false }));
try { await parkUntilSignal(); } finally { await ui.close(); backend.closeAllConnections(); await new Promise<void>(resolve => backend.close(() => resolve())); }
