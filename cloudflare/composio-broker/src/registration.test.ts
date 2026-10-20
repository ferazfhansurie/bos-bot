import { describe, expect, it } from "vitest";

import worker, { dailyRegistrationCap, sha256 } from "./index";

function registrationEnv(recent: number, cap?: string) {
  const keys: string[] = [];
  const inserts: unknown[][] = [];
  const env = {
    REGISTRATION_MODE: "open",
    ...(cap === undefined ? {} : { DAILY_REGISTRATION_CAP: cap }),
    REGISTRATION_LIMITER: { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.filter(k => k === key).length <= 2 }; } },
    DB: {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => (sql.startsWith("SELECT COUNT(*)") ? { n: recent } : null),
              run: async () => { inserts.push(values); },
            };
          },
        };
      },
    },
  };
  return { env, keys, inserts };
}

const register = (env: unknown, ip: string, agent: string) =>
  worker.fetch(new Request("https://broker.test/v1/installations", { method: "POST", headers: { "cf-connecting-ip": ip, "user-agent": agent } }), env as never, { waitUntil() {}, passThroughOnException() {} } as never);

describe("installation registration", () => {
  it("rate limits by address, whatever user agent the caller sends", async () => {
    const { env, keys } = registrationEnv(0);
    expect((await register(env, "203.0.113.7", "agent-a")).status).toBe(201);
    expect((await register(env, "203.0.113.7", "agent-b")).status).toBe(201);
    expect((await register(env, "203.0.113.7", "agent-c")).status).toBe(429);
    expect(new Set(keys)).toEqual(new Set([await sha256("203.0.113.7")]));
    expect((await register(env, "198.51.100.4", "agent-a")).status).toBe(201);
  });

  it("stops registering once the day's global cap is reached", async () => {
    const under = registrationEnv(499);
    expect((await register(under.env, "203.0.113.8", "a")).status).toBe(201);
    const full = registrationEnv(500);
    const refused = await register(full.env, "203.0.113.9", "a");
    expect(refused.status).toBe(503);
    expect(full.inserts).toEqual([]);
    const lowered = registrationEnv(3, "3");
    expect((await register(lowered.env, "203.0.113.10", "a")).status).toBe(503);
  });

  it("falls back to the default cap on a missing or malformed setting", () => {
    expect(dailyRegistrationCap({})).toBe(500);
    expect(dailyRegistrationCap({ DAILY_REGISTRATION_CAP: "abc" })).toBe(500);
    expect(dailyRegistrationCap({ DAILY_REGISTRATION_CAP: "0" })).toBe(500);
    expect(dailyRegistrationCap({ DAILY_REGISTRATION_CAP: "50" })).toBe(50);
  });
});
