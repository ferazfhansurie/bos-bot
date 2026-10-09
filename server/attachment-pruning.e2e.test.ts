import type { SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

const cap = 2 * 1024 ** 3;
const retainedName = "11111111-1111-4111-8111-111111111111.png";
const orphanName = "22222222-2222-4222-8222-222222222222.png";
vi.mock("node:child_process", async (importOriginal) => {
  const childProcess = await importOriginal<typeof import("node:child_process")>();
  return {
    ...childProcess,
    spawn(command: string, args: readonly string[], options: SpawnOptions) {
      const dataDir = options.env?.OMB_DATA_DIR;
      if (!dataDir || !args.includes(join(process.cwd(), "server", "index.ts"))) throw new Error("Expected isolated fixture server");
      const dir = join(dataDir, "attachments");
      mkdirSync(dir);
      const retained = join(dir, retainedName);
      const orphan = join(dir, orphanName);
      writeFileSync(retained, "x");
      truncateSync(retained, cap - 3);
      writeFileSync(orphan, "old");
      const old = new Date(Date.now() - 3 * 86400_000);
      utimesSync(retained, old, old);
      utimesSync(orphan, old, old);
      writeFileSync(join(dataDir, "messages-retained-fixture.json"), JSON.stringify([{ text: `<attached-image path="${retained}"/>` }]));
      return childProcess.spawn(command, args, options);
    },
  };
});

it("admits an HTTP paste by pruning an orphan and returns an actionable quota error for protected storage", async () => {
  const session = await launchVerificationServer();
  try {
    await expect(runControlOmb(["doctor", "--url", session.info.url])).resolves.toMatchObject({ ok: true });
    const upload = () => fetch(`${session.info.url}/api/attachments`, {
      method: "POST", headers: { "content-type": "image/png" }, body: "new",
    });
    const response = await upload();
    expect(response.status).toBe(201);
    const saved = await response.json() as { path: string; bytes: number };
    expect(saved.bytes).toBe(3);
    expect(existsSync(join(session.info.dataDir, "attachments", orphanName))).toBe(false);
    expect(statSync(join(session.info.dataDir, "attachments", retainedName)).size).toBe(cap - 3);
    const preview = await fetch(`${session.info.url}/api/attachments/${saved.path.split(/[\\/]/).at(-1)}`);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("new");
    const blocked = await upload();
    expect(blocked.status).toBe(507);
    expect(await blocked.json()).toEqual({ error: expect.stringMatching(/storage is full.*remove.*retry/i) });
  } finally {
    await session.close();
  }
  expect(existsSync(session.info.dataDir)).toBe(false);
}, 30_000);
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
