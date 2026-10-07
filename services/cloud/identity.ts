import { createHash } from "node:crypto";
export class CloudError extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 403) {
    super(code);
    this.status = status;
    this.code = code;
  }
}
export type Identity = {
  account_id: string;
  issuer: string;
  subject: string;
  service: string;
  validated_at: number;
  expires_at: number;
};
export interface IssuerAdapter {
  validate(
    bearer: string,
    options: { fresh: true; signal: AbortSignal },
  ): Promise<Identity>;
}
export async function currentIdentity(
  adapter: IssuerAdapter,
  bearer: string,
): Promise<Identity> {
  const started = Date.now();
  const signal = AbortSignal.timeout(3000);
  const i = await Promise.race([
    adapter.validate(bearer, { fresh: true, signal }),
    new Promise<never>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new CloudError("identity_unavailable", 503)),
        { once: true },
      ),
    ),
  ]);
  if (
    !i.account_id ||
    !i.subject ||
    !i.issuer ||
    i.validated_at < started ||
    i.expires_at > i.validated_at + 15000 ||
    i.expires_at <= Date.now()
  )
    throw new CloudError("identity_unavailable", 503);
  return i;
}

/** Only the configured issuer can establish identity. PG owns every grant. */
export class ControlPlaneIssuer implements IssuerAdapter {
  readonly issuer: string;
  readonly service: string;
  constructor(issuer: string, service: string) {
    const url = new URL(issuer);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))))
      throw new Error('issuer requires HTTPS or local loopback origin');
    this.issuer = url.origin;
    this.service = service;
  }
  async validate(credential: string, {signal}: {fresh:true;signal:AbortSignal}): Promise<Identity> {
    const headers = new Headers({'cache-control':'no-cache, no-store','pragma':'no-cache'});
    if (credential.startsWith('cookie\0')) headers.set('cookie',credential.slice(7));
    else headers.set('authorization','Bearer '+credential);
    let response: Response;
    try {
      response = await fetch(this.issuer+'/v1/me',{headers,signal,redirect:'error',cache:'no-store'});
    } catch { throw new CloudError('identity_unavailable',503); }
    if (response.status === 401) throw new CloudError('session_invalid',401);
    if (!response.ok) throw new CloudError('identity_unavailable',503);
    let payload: any;
    try { payload = await response.json(); } catch { throw new CloudError('identity_unavailable',503); }
    const subject = payload?.user?.id;
    if (typeof subject !== 'string' || !subject || subject.length>128) throw new CloudError('identity_unavailable',503);
    const now = Date.now();
    return {account_id:'a_'+createHash('sha256').update(this.issuer+'\0'+subject).digest('hex').slice(0,40),issuer:this.issuer,subject,service:this.service,validated_at:now,expires_at:now+15000};
  }
}
