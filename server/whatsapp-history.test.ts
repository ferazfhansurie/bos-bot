import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { historyFailure, WhatsAppHistoryError } from "./whatsapp-history.ts";

it("preserves diagnostic stages across the real separate-bundle boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bos-wa-history-bundles-"));
  try {
    const helper = join(import.meta.dirname, "whatsapp-history.ts");
    writeFileSync(join(dir, "adapter.ts"), `import { WhatsAppHistoryError } from ${JSON.stringify(helper)}; export const failure = new WhatsAppHistoryError(502, 'chat_lookup');`);
    writeFileSync(join(dir, "server.ts"), `export { WhatsAppHistoryError, historyFailure } from ${JSON.stringify(helper)};`);
    await build({ entryPoints: [join(dir, "adapter.ts"), join(dir, "server.ts")], outdir: dir, bundle: true, format: "esm", platform: "node", outExtension: { ".js": ".mjs" }, logLevel: "silent" });
    const adapter = await import(pathToFileURL(join(dir, "adapter.mjs")).href);
    const server = await import(pathToFileURL(join(dir, "server.mjs")).href);
    expect(adapter.failure instanceof server.WhatsAppHistoryError).toBe(false);
    expect(server.historyFailure(adapter.failure)).toMatchObject({ status: 502, stage: "chat_lookup" });
    expect(historyFailure(adapter.failure)).toMatchObject({ status: 502, stage: "chat_lookup" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it("does not propagate arbitrary status, stage or provider secrets", () => {
  expect(historyFailure({ code: "bos_whatsapp_history", status: 200, stage: "chat_lookup", message: "private provider data" })).toMatchObject({ status: 502, stage: "chat_lookup" });
  expect(historyFailure({ code: "bos_whatsapp_history", stage: "private provider data" })).toMatchObject({ status: 502, stage: "native_history" });
  expect(historyFailure(new Error("private provider data")).message).not.toContain("private provider data");
  expect(historyFailure(new WhatsAppHistoryError(403, "account_or_scope_changed"))).toMatchObject({ status: 403, stage: "account_or_scope_changed" });
});
