import { createServer, request, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createProxyHandler } from "../src/proxy.ts";

const listen = (server: Server): Promise<number> => new Promise(resolve =>
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
};

describe("phone media upload deadline", () => {
  it("lets a video finish transferring before starting the response deadline", async () => {
    let received = 0;
    const harness = createServer((req, res) => {
      req.on("data", chunk => { received += chunk.length; });
      req.on("end", () => { res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ bytes: received })); });
    });
    const harnessPort = await listen(harness);
    const sidecar = createServer(createProxyHandler({ harnessPort,
      authenticate: () => ({ id: "fixture-phone", cloudDesktopAccess: true }),
      redeem: () => ({ error: "unused" }), serverName: () => "Fixture", headersTimeoutMs: 50 }));
    const port = await listen(sidecar);
    try {
      const result = await new Promise<{ status: number; bytes: number }>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/files?name=Video.mp4", method: "POST",
          headers: { authorization: "Bearer fixture-token", "content-type": "video/mp4", "content-length": "8" } }, res => {
          let text = ""; res.on("data", chunk => { text += chunk; });
          res.on("end", () => resolve({ status: res.statusCode!, bytes: JSON.parse(text).bytes }));
        });
        req.on("error", reject);
        req.write(Buffer.alloc(4, 1));
        const timer = setTimeout(() => req.end(Buffer.alloc(4, 2)), 180);
        req.on("close", () => clearTimeout(timer));
      });
      expect(result).toEqual({ status: 201, bytes: 8 });
    } finally { await close(sidecar); await close(harness); }
  });

  it("still times out a harness that stops responding after the upload", async () => {
    const harness = createServer(req => { req.resume(); });
    const harnessPort = await listen(harness);
    const sidecar = createServer(createProxyHandler({ harnessPort,
      authenticate: () => ({ cloudDesktopAccess: true }), redeem: () => ({ error: "unused" }),
      serverName: () => "Fixture", headersTimeoutMs: 50 }));
    const port = await listen(sidecar);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/files?name=Video.mp4`, {
        method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "video/mp4" }, body: new Uint8Array([1]) });
      expect(res.status).toBe(504);
    } finally { await close(sidecar); await close(harness); }
  });
});
