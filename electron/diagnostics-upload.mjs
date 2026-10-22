import { redactSecretsInLine } from "./diagnostics.mjs";

/** Called only by a trusted local renderer's explicit Send report action. */
export async function sendDiagnosticsReport(report, transport = fetch) {
  const body = JSON.stringify({ report: redactSecretsInLine(report) });
  if (Buffer.byteLength(body, "utf8") > 5 * 1024 * 1024) {
    throw new Error("This report exceeds 5 MB. Export diagnostics instead.");
  }
  let response;
  try {
    response = await transport("https://bosbot.my/api/diag", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error("upload failed");
  } catch {
    throw new Error("The report could not be sent. Check your connection and try again.");
  }
  const receipt = await response.json().catch(() => null);
  if (typeof receipt?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id)) {
    throw new Error("The team did not return a report id. Try again.");
  }
  return { id: receipt.id };
}
