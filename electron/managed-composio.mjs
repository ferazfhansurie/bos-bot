import { compatEnv, compatEnvironment } from "./branding-env.cjs";
const TOKEN = /^[0-9a-f]{64}$/;

export function normalizeManagedComposioBrokerUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "";
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return "";
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return "";
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** BOS_COMPOSIO_BROKER_URL wins over the legacy OMB_COMPOSIO_BROKER_URL.
 * Only the environment is read here; the packaged app's hosted default is
 * desktopComposioBrokerUrl below. */
export function resolveManagedComposioBrokerUrl(environment = compatEnv) {
  const configured =
    compatEnvironment(environment)?.BOS_COMPOSIO_BROKER_URL?.trim() || compatEnvironment(environment)?.OMB_COMPOSIO_BROKER_URL?.trim() || "";
  return normalizeManagedComposioBrokerUrl(configured);
}

/** bos bot's own connected-apps broker (bos-web broker/host.mjs behind
 * bosbot.my). Each install registers its own revocable token there; the
 * Composio project key never leaves the server. */
export const HOSTED_COMPOSIO_BROKER_URL = "https://bosbot.my/composio";
const OFF = /^(off|0|false|none|disabled)$/i;

/** Which broker a packaged desktop app uses: an operator's environment URL,
 * else a setup preset's broker, else the hosted one. BOS_COMPOSIO_BROKER_URL=off
 * turns the managed broker off entirely (a Composio key in settings still works). */
export function desktopComposioBrokerUrl({ environment = compatEnv, presetUrl } = {}) {
  const env = compatEnvironment(environment);
  const raw = env?.BOS_COMPOSIO_BROKER_URL?.trim() || env?.OMB_COMPOSIO_BROKER_URL?.trim() || "";
  if (OFF.test(raw)) return "";
  return resolveManagedComposioBrokerUrl(environment) || normalizeManagedComposioBrokerUrl(presetUrl) || HOSTED_COMPOSIO_BROKER_URL;
}

export function managedComposioAccess(brokerUrl, credentials) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  const token = credentials?.composioBrokerToken;
  if (!url || !TOKEN.test(token ?? "")) return null;
  return { url, token };
}

export function managedComposioChildEnvironment(brokerUrl, credentials, environment) {
  const next = { ...environment };
  delete next.OMB_COMPOSIO_BROKER_URL;
  delete next.OMB_COMPOSIO_BROKER_TOKEN;
  delete next.BOS_COMPOSIO_BROKER_URL;
  const access = managedComposioAccess(brokerUrl, credentials);
  if (access) {
    next.OMB_COMPOSIO_BROKER_URL = access.url;
    next.OMB_COMPOSIO_BROKER_TOKEN = access.token;
  }
  return next;
}

export async function ensureManagedComposioCredentials({
  brokerUrl,
  credentials,
  fetchImpl = globalThis.fetch,
  saveCredentials,
  installId,
  log = () => {},
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  existingCredentialTimeoutMs = 8_000,
  registrationTimeoutMs = 15_000,
}) {
  const url = normalizeManagedComposioBrokerUrl(brokerUrl);
  if (!url) {
    if (brokerUrl) log("connected-apps broker URL rejected: HTTPS or a loopback HTTP URL is required");
    return credentials;
  }
  if (TOKEN.test(credentials.composioBrokerToken ?? "")) {
    try {
      const check = await fetchImpl(`${url}/v1/me`, {
        headers: { authorization: `Bearer ${credentials.composioBrokerToken}` },
        redirect: "error",
        signal: timeoutSignal(existingCredentialTimeoutMs),
      });
      if (check.ok) return credentials;
      // Only a definitive auth failure rotates the credential. A transient
      // outage keeps the existing identity so reconnecting cannot strand the
      // user's already-authorized accounts under a new installation.
      if (check.status !== 401) return credentials;
      delete credentials.composioBrokerToken;
      delete credentials.composioInstallationId;
    } catch {
      return credentials;
    }
  }
  try {
    const response = await fetchImpl(`${url}/v1/installations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // the anonymous install id (the one bos ai registration already sends)
      // lets the operator see usage per install; the broker ignores it otherwise
      body: JSON.stringify(typeof installId === "string" && /^[0-9a-f-]{36}$/i.test(installId) ? { install: installId.toLowerCase() } : {}),
      redirect: "error",
      signal: timeoutSignal(registrationTimeoutMs),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
    if (!TOKEN.test(body?.token ?? "") || typeof body?.installationId !== "string") {
      throw new Error("the connected-apps service returned invalid credentials");
    }
    credentials.composioBrokerToken = body.token;
    credentials.composioInstallationId = body.installationId;
    await saveCredentials(credentials);
    log("connected-apps installation registered");
  } catch (error) {
    // This operation always settles locally. The caller runs it after first
    // paint, so an optional hosted integration cannot delay desktop readiness.
    log(`connected-apps registration failed: ${error?.message ?? error}`);
  }
  return credentials;
}
// branding compatibility (electron/branding-compat.json): environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
