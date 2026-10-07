import { randomBytes, createHash } from "node:crypto";
import { CloudError } from "./identity.ts";
import type { Identity, IssuerAdapter } from "./identity.ts";
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
