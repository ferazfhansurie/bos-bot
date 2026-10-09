import { compatEnv, compatEnvironment } from "../electron/branding-env.cjs";
// The operator workspace's side of the fleet agent: one request over the
// agent's Unix socket, JSON in and out. The socket's permissions are the
// whole authorisation; this process can open it only because the operator
// user was named at `fleet init`.
import { existsSync } from "node:fs";
import { request } from "node:http";

export interface FleetReply {
  status: number;
  body: unknown;
}

export function fleetSocketPath(env: NodeJS.ProcessEnv = compatEnv): string {
  return compatEnvironment(env).OMB_FLEET_SOCKET?.trim() || "/run/bosbot/fleet.sock";
}

/** Whether this server can reach a fleet agent at all. */
export function fleetAvailable(socketPath = fleetSocketPath()): boolean {
  return existsSync(socketPath);
}

export function fleetRequest(socketPath: string, method: string, path: string, body?: unknown, timeoutMs = 15 * 60_000): Promise<FleetReply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      { socketPath, method, path, headers: { "content-type": "application/json", ...(payload ? { "content-length": Buffer.byteLength(payload) } : {}) }, timeout: timeoutMs },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { if (text.length < 1_000_000) text += chunk; });
        res.on("end", () => {
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: "the fleet agent answered something that was not JSON" }; }
          resolve({ status: res.statusCode ?? 502, body: parsed });
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("the fleet agent did not answer in time")); });
    req.on("error", (error: NodeJS.ErrnoException) => {
      reject(new Error(error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? "no fleet agent on this server: run `bosbot fleet init --domain … --operator <this user>` as root"
        : error.code === "EACCES"
          ? "this workspace's user may not open the fleet socket: re-run `bosbot fleet init` with --operator set to it"
          : `fleet agent: ${error.message}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
