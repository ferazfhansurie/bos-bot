import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export function belowMinimumVersion(current, minimum) {
  if (typeof minimum !== "string" || !stable.test(minimum) || typeof current !== "string") return false;
  const running = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(current);
  if (!running) return false;
  const target = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const value = Number(running[i + 1]);
    if (value !== target[i]) return value < target[i];
  }
  return Boolean(running[4]);
}

export async function fetchUpdatePolicy(request = globalThis.fetch) {
  try {
    const response = await request("https://bosbot.my/api/app-config", {
      signal: AbortSignal.timeout(8_000), redirect: "error", headers: { accept: "application/json" },
    });
    if (!response.ok || !response.body) return null;
    // A broken endpoint must not allocate an unbounded response in Electron.
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    try {
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 64 * 1024) { await reader.cancel(); return null; }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const config = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const minimum = config?.minVersion?.desktop;
    return {
      minimumVersion: typeof minimum === "string" && stable.test(minimum) ? minimum : null,
      autoUpdates: config?.flags?.autoUpdates === true,
    };
  } catch { return null; }
}

export async function fetchMinimumVersion(request = globalThis.fetch) {
  return (await fetchUpdatePolicy(request))?.minimumVersion ?? null;
}

export function updateTelemetryState(state) {
  if (state.status === "error") {
    const message = state.message ?? "";
    const kind = /sha(?:256|512)|checksum|signature|verification/i.test(message) ? "verification"
      : /ENOTFOUND|ECONN|ETIMEDOUT|net::|offline|network|connection|download was interrupted|server is unavailable/i.test(message) ? "network"
      : /404|\.yml|feed|no published|files are missing or invalid/i.test(message) ? "feed"
      : /install|handoff|prepar|lifecycle|busy|restart/i.test(message) ? "install" : "unknown";
    return `failed:${kind}`;
  }
  if (["downloading", "preparing"].includes(state.status)) return "downloading";
  if (["downloaded", "installing", "handed-off"].includes(state.status)) return "downloaded";
  return state.status === "checking" ? "checking" : "idle";
}

export function persistUpdateState(dataDir, state) {
  if (!dataDir) return;
  try {
    mkdirSync(dataDir, {recursive: true, mode: 0o700});
    const file = join(dataDir, "update-state.json");
    const pending = `${file}.${process.pid}.tmp`;
    writeFileSync(pending, JSON.stringify({update_state: updateTelemetryState(state), updatedAt: new Date().toISOString()}), {mode: 0o600});
    renameSync(pending, file);
  } catch { /* Telemetry must never stop a verified update. */ }
}
