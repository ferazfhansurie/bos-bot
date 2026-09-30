// Shared canonical wire contract. No secrets, credentials, or tool payloads.
export const REMOTE_FULL_PROTOCOL = "bos.remote-full.v1";
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
// Control and bidi overrides cannot disguise targets in a native confirmation.
// eslint-disable-next-line no-control-regex
const text = (v, max = 256) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(v);
const keys = (v, ks) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === ks.sort().join();
export function parseChallenge(v) {
  if (!keys(v, ["protocol", "nonce", "environmentId", "installationId", "serverKey", "audience", "expiresAt", "operations"]) || v.protocol !== REMOTE_FULL_PROTOCOL ||
      !text(v.nonce, 64) || !/^[a-f0-9]{64}$/.test(v.nonce) || !text(v.environmentId) || !text(v.installationId) || !/^[A-Za-z0-9_-]{43}$/.test(v.serverKey) || !Number.isSafeInteger(v.expiresAt) ||
      !Array.isArray(v.operations) || v.operations.length < 1 || v.operations.length > 8) throw new Error("Invalid remote approval challenge");
  const u = new URL(v.audience);
  if (u.protocol !== "https:" || u.origin !== v.audience || u.username || u.password) throw new Error("Invalid remote approval audience");
  const ids = new Set();
  for (const op of v.operations) {
    if (!keys(op, ["botId", "threadId", "name", "title", "modelSelection", "revision", "updateBotDefault", "mode"]) || !text(op.botId) || !text(op.threadId) || !text(op.name) || !text(op.title) ||
        !text(op.revision, 64) || !/^[a-f0-9]{64}$/.test(op.revision) || op.mode !== "full" || typeof op.updateBotDefault !== "boolean" || ids.has(op.botId) ||
        !op.modelSelection || typeof op.modelSelection !== "object" || Array.isArray(op.modelSelection) || Object.keys(op.modelSelection).some(k => !["instanceId", "model", "effort", "variant"].includes(k)) || (op.modelSelection.effort !== undefined && !text(op.modelSelection.effort, 64)) || (op.modelSelection.variant !== undefined && !text(op.modelSelection.variant, 128)) || !text(op.modelSelection.instanceId) || !text(op.modelSelection.model) || canonical(op.modelSelection).length > 1024) throw new Error("Invalid remote approval operation");
    ids.add(op.botId);
  }
  return v;
}
