import { randomBytes, createHash } from "node:crypto";
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
/** Fictional test issuer: immutable subject, audience-bound <=15s assertion, no grants. */
export class StubIssuer implements IssuerAdapter {
  issuer = "http://stub-issuer.invalid";
  service: string;
  sessions = new Map<string, string>();
  revoked = new Set<string>();
  unavailable = false;
  stallMs = 0;
  constructor(service: string) {
    this.service = service;
  }
  signin(subject: string) {
    if (!/^fictional_[a-zA-Z0-9_-]{1,80}$/.test(subject))
      throw new CloudError("invalid_request", 400);
    const bearer = randomBytes(32).toString("base64url");
    this.sessions.set(bearer, subject);
    return { bearer, ...this.assertion(subject) };
  }
  assertion(subject: string): Identity {
    const now = Date.now();
    return {
      account_id:
        "a_" +
        createHash("sha256")
          .update(this.issuer + "\0" + subject)
          .digest("hex")
          .slice(0, 40),
      issuer: this.issuer,
      subject,
      service: this.service,
      validated_at: now,
      expires_at: now + 15000,
    };
  }
  async validate(
    bearer: string,
    { signal }: { fresh: true; signal: AbortSignal },
  ): Promise<Identity> {
    if (this.stallMs)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.stallMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new CloudError("identity_unavailable", 503));
          },
          { once: true },
        );
      });
    if (signal.aborted || this.unavailable)
      throw new CloudError("identity_unavailable", 503);
    const subject = this.sessions.get(bearer);
    if (!subject || this.revoked.has(bearer))
      throw new CloudError("unauthenticated", 401);
    return this.assertion(subject);
  }
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
