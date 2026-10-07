import assert from 'node:assert/strict';

const privateKeys = /^(authorization|cookie|set-cookie|token|access_token|refresh_token|bearer|session|session_token|secret|invite_token)$/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, data]) => [key, privateKeys.test(key) ? '[redacted]' : redact(data)]));
  return value;
}
export function localURL(input) {
  const url = new URL(input);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname), 'isolated loopback HTTP fixture required');
  assert.ok(!url.username && !url.password, 'no credentials in fixture URL');
  return url;
}
export class Transport {
  constructor(baseURL, record) {
    this.base = localURL(baseURL);
    this.record = record;
  }
  async request(path, { method = 'GET', token, body, discardResponse = false } = {}) {
    const url = localURL(new URL(path, this.base));
    assert.equal(url.origin, this.base.origin, 'request must stay on explicit fixture origin');
    const started = performance.now();
    const response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { non_json: true, bytes: Buffer.byteLength(raw) }; }
    this.record({ type: 'http', method, path: url.pathname, status: response.status,
      duration_ms: performance.now() - started, response: redact(data), discarded: discardResponse });
    // Consume then hide the response to model loss after admission; no automatic retry.
    if (discardResponse) return { status: 'transport_unknown' };
    return { status: response.status, data, raw };
  }
}
