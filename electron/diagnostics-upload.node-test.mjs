import assert from "node:assert/strict";
import test from "node:test";
import { sendDiagnosticsReport } from "./diagnostics-upload.mjs";

test("posts a redacted bundle only to the fixed receiver and returns its id", async () => {
  let sent;
  const result = await sendDiagnosticsReport("OPENAI_API_KEY=sk-example-secret", async (url, options) => {
    sent = { url, options };
    return { ok: true, json: async () => ({ id: "diag-test-123" }) };
  });
  assert.deepEqual(result, { id: "diag-test-123" });
  assert.equal(sent.url, "https://bosbot.my/api/diag");
  assert.equal(sent.options.redirect, "error");
  assert.equal(sent.options.credentials, "omit");
  assert.doesNotMatch(sent.options.body, /sk-example-secret/);
});
test("oversize bundles never call the transport", async () => {
  await assert.rejects(sendDiagnosticsReport("a".repeat(5 * 1024 * 1024), () => assert.fail("must not send")), /5 MB/);
});
test("upload failures and invalid receipts are plain errors", async () => {
  await assert.rejects(sendDiagnosticsReport("report", async () => ({ ok: false })), /could not be sent/);
  await assert.rejects(sendDiagnosticsReport("report", async () => ({ ok: true, json: async () => ({ id: "" }) })), /report id/);
  await assert.rejects(sendDiagnosticsReport("report", async () => { throw Error("secret transport details"); }), /could not be sent/);
});
