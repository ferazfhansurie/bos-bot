// A setup preset link: bosbot://setup?for=<token>, opened from a guide page
// made for one person after they install. The token is claimed once from
// app.bosbot.my, which answers with the preset (server/onboarding-preset.ts)
// and, when the person has none, a connected-apps broker installation of
// their own. The token itself grants nothing on this computer.
import { PACKAGE_SCHEMES } from './release-channel.mjs';
import { normalizeManagedComposioBrokerUrl } from './managed-composio.mjs';

const TOKEN = /^[\w-]{20,64}$/;
const BROKER_TOKEN = /^[0-9a-f]{64}$/;
export const PRESET_CLAIM_URL = 'https://app.bosbot.my/api/preset/claim';

/** The token in a setup link, or null for anything else. */
export function presetTokenFromLink(raw) {
  try {
    const url = new URL(String(raw));
    if (!PACKAGE_SCHEMES.includes(url.protocol.slice(0, -1)) || url.hostname !== 'setup') return null;
    if (!['', '/'].includes(url.pathname) || url.hash || url.username || url.password || url.port) return null;
    if ([...url.searchParams.keys()].some((key) => key !== 'for') || url.searchParams.getAll('for').length !== 1) return null;
    const token = url.searchParams.get('for') ?? '';
    return TOKEN.test(token) ? token : null;
  } catch { return null; }
}

/** The claim answer, checked: a preset object, and broker access only when it
 * is a well-formed HTTPS broker and token. */
export function parsePresetClaim(body) {
  if (!body || typeof body !== 'object' || !body.preset || typeof body.preset !== 'object' || Array.isArray(body.preset)) return null;
  const broker = body.composio;
  const url = broker && typeof broker === 'object' ? normalizeManagedComposioBrokerUrl(broker.url) : '';
  const composio = url.startsWith('https://') && BROKER_TOKEN.test(broker?.token ?? '') ? { url, token: broker.token } : null;
  return { preset: body.preset, composio };
}

export async function claimPreset(token, { fetchImpl = globalThis.fetch, url = PRESET_CLAIM_URL, timeoutMs = 20_000 } = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error.slice(0, 200) : `HTTP ${response.status}`);
  const claim = parsePresetClaim(body);
  if (!claim) throw new Error('the setup link answered with no preset');
  return claim;
}

/** Keep an existing connected-apps identity: replacing it would strand every
 * account the person already linked. Only a computer with none takes the
 * preset's installation. */
export function withPresetBroker(credentials, composio) {
  if (!composio || BROKER_TOKEN.test(credentials.composioBrokerToken ?? '')) return false;
  credentials.composioBrokerToken = composio.token;
  credentials.composioBrokerUrl = composio.url;
  delete credentials.composioInstallationId;
  return true;
}
