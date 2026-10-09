import { compatEnv } from "../electron/branding-env.cjs";
// Near-side gate for the host CUA process. The descriptor and turn token
// travel in environment variables, never command-line arguments or logs.
import { runMcpBridge } from "./mcp-bridge.ts";
import { augmentedPath } from "./env-path.ts";

const {
  OMB_CUA_COMMAND: command,
  OMB_CUA_ARGS: encodedArgs,
  OMB_CONTROL_URL: url,
  OMB_CONTROL_TOKEN: token,
  ...childEnv
} = compatEnv;

let args: string[];
try {
  const parsed: unknown = JSON.parse(encodedArgs ?? "");
  const endpoint = new URL(url ?? "");
  if (!command?.trim() || command.includes("\0") ||
      !Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string" && !arg.includes("\0")) ||
      !token || !["http:", "https:"].includes(endpoint.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw new Error("invalid connection");
  }
  args = parsed;
} catch {
  process.stderr.write("invalid local computer proxy connection\n");
  process.exit(2);
}

runMcpBridge({
  command: command!,
  args,
  env: { ...childEnv, PATH: augmentedPath() },
  label: "Local Cua Driver",
  gate: { url: url!, token: token! },
});
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
