import { betterAuth } from "better-auth";
import { bearer, emailOTP } from "better-auth/plugins";

import type { ControlPlaneConfig } from "./config";
import { sendOTPEmail } from "./email";

export function createAuth(
  env: Env,
  ctx: ExecutionContext,
  config: ControlPlaneConfig,
  requestId: string,
  runtime: {secureCookies?: boolean; sendOTP?: (input: import("./email").OTPEmailInput) => Promise<void>} = {},
) {
  // Latest authoritative session state, including when D1 read replication is enabled.
  // Better Auth identifies D1 by prepare/batch/exec; preserve the binding interface.
  const primary = env.DB.withSession("first-primary");
  const database: D1Database = Object.assign(Object.create(env.DB), {
    prepare: primary.prepare.bind(primary), batch: primary.batch.bind(primary),
  });
  return betterAuth({
    appName: "BOS Bot",
    baseURL: config.authBaseURL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database,
    trustedOrigins: [...config.allowedOrigins],
    logger: { disabled: true },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 60,
      customRules: {
        "/email-otp/send-verification-otp": { window: 60, max: 5 },
        "/sign-in/email-otp": { window: 60, max: 10 },
      },
    },
    advanced: {
      useSecureCookies: runtime.secureCookies ?? true,
      ipAddress: {
        // Cloudflare writes this header at the edge. Do not trust a client-
        // supplied x-forwarded-for chain for rate limits or session metadata.
        ipAddressHeaders: ["cf-connecting-ip"],
      },
      database: { generateId: "uuid" },
      backgroundTasks: {
        handler(promise) {
          ctx.waitUntil(promise);
        },
      },
    },
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: 10 * 60,
        allowedAttempts: 5,
        storeOTP: "hashed",
        resendStrategy: "rotate",
        disableSignUp: false,
        rateLimit: { window: 60, max: 5 },
        async sendVerificationOTP(input) {
          if (runtime.sendOTP) return runtime.sendOTP(input);
          await sendOTPEmail({
            async send(message) {
              await env.EMAIL.send(message);
            },
          }, config.emailFrom, input, requestId);
        },
      }),
      bearer({ requireSignature: true }),
    ],
  });
}

export type ControlPlaneAuth = ReturnType<typeof createAuth>;

export async function accountSession(request: Request, auth: ControlPlaneAuth, allowCookie = false) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (authorization && (!match || match[1].startsWith("omb_install_"))) return null;
  if (!match && (!allowCookie || !request.headers.has("cookie"))) return null;
  const headers = match
    ? new Headers({authorization:`Bearer ${match[1]}`})
    : new Headers({cookie:request.headers.get("cookie")!});
  // Always hit current D1 session state. A signed cached cookie cannot restore a revoked session.
  return auth.api.getSession({headers,query:{disableCookieCache:true,disableRefresh:true}});
}
