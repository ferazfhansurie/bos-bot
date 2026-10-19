// Contract test for the sandbox MCP proxy: launch the real stdio entrypoint
// against a scripted harness and check the desktop tools' listing and the
// screenshot's image content block.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "sandbox-proxy.ts");

let stub: Server;
let stubPort = 0;
const seen: Array<{ path: string; authorization?: string; body: unknown }> = [];
const children: ChildProcess[] = [];

function launch(desktop: boolean) {
  const child = spawn(process.execPath, [PROXY], {
    env: {
      ...process.env,
      OMB_HARNESS_URL: `http://127.0.0.1:${stubPort}`,
      OMB_SANDBOX_TOKEN: "turn-token",
      OMB_SANDBOX_DESKTOP: desktop ? "1" : "",
    },
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(child);
  const pending = new Map<number, (message: any) => void>();
  let nextId = 1;
  let buffer = "";
  child.stdout!.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });
  return (method: string, params?: unknown): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 10_000).unref?.();
    });
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body: data ? JSON.parse(data) : undefined });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/internal/sandbox/sandbox_desktop_screenshot") {
        return res.end(JSON.stringify({ text: "Screenshot of the 1280x800 cloud desktop.", image: { data: "iVBORw0KGgo=", mimeType: "image/png" } }));
      }
      if (req.url === "/api/internal/sandbox/sandbox_desktop_click") {
        res.statusCode = 409;
        return res.end(JSON.stringify({ error: "the cloud desktop needs a large sandbox" }));
      }
      res.end(JSON.stringify({ text: "ok" }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubPort = (stub.address() as { port: number }).port;
});

afterAll(async () => {
  for (const child of children) child.kill();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

describe("sandbox-proxy MCP surface", () => {
  it("lists the cloud desktop tools only on the BoxCompute place", async () => {
    const plain = launch(false);
    const names = (await plain("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toContain("sandbox_exec");
    expect(names.some((name: string) => name.startsWith("sandbox_desktop_"))).toBe(false);
    expect((await plain("tools/call", { name: "sandbox_desktop_screenshot", arguments: {} })).error.message).toMatch(/Unknown tool/);

    const desktop = launch(true);
    const listed = (await desktop("tools/list")).result.tools.map((tool: { name: string }) => tool.name);
    expect(listed).toEqual(expect.arrayContaining([
      "sandbox_exec",
      "sandbox_desktop_screenshot",
      "sandbox_desktop_click",
      "sandbox_desktop_type",
      "sandbox_desktop_key",
      "sandbox_desktop_scroll",
      "sandbox_desktop_open_url",
      "sandbox_desktop_live_link",
    ]));
  });

  it("returns the screenshot as an image the model can see, and errors as text", async () => {
    const desktop = launch(true);
    const shot = await desktop("tools/call", { name: "sandbox_desktop_screenshot", arguments: {} });
    expect(shot.result.isError).toBe(false);
    expect(shot.result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
      { type: "text", text: "Screenshot of the 1280x800 cloud desktop." },
    ]);
    expect(seen.at(-1)?.authorization).toBe("Bearer turn-token");

    const click = await desktop("tools/call", { name: "sandbox_desktop_click", arguments: { x: 1, y: 2 } });
    expect(click.result).toEqual({ content: [{ type: "text", text: "the cloud desktop needs a large sandbox" }], isError: true });
    expect(seen.at(-1)?.body).toEqual({ x: 1, y: 2 });
  });
});
