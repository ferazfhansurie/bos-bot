// Web push has to be byte-exact: a browser silently drops a payload it can't
// decrypt. So the test plays the browser: it holds the subscription's private
// key, decrypts what the server sent per RFC 8291, and checks the VAPID token
// verifies under the public key the browser subscribed with.
import { createDecipheriv, createECDH, createHash, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { WebPush, encryptPayload, isPushEndpoint } from "./web-push.ts";

const OWNER = "env:person:owner";

function browser() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, publicKey, auth, keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") } };
}

function decrypt(body: Buffer, b: ReturnType<typeof browser>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  const shared = b.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, b.auth, Buffer.concat([Buffer.from("WebPush: info\0"), b.publicKey, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

function verifyVapid(header: string, endpoint: string) {
  const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  expect(match).not.toBeNull();
  const [head, claims, signature] = match![1]!.split(".");
  const raw = Buffer.from(match![2]!, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  expect(verify("sha256", Buffer.from(`${head}.${claims}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString());
  expect(decoded.aud).toBe(new URL(endpoint).origin);
  expect(decoded.exp).toBeGreaterThan(Date.now() / 1000);
  return match![2]!;
}

describe("web push", () => {
  it("only accepts endpoints on a browser vendor's push service", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QG")).toBe(true);
    expect(isPushEndpoint("https://wns2-db5p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com.evil.example/x")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
    expect(isPushEndpoint("https://user:pw@fcm.googleapis.com/x")).toBe(false);
  });

  it("encrypts a payload the browser can open", () => {
    const b = browser();
    const body = encryptPayload(Buffer.from('{"hi":1}'), b.keys.p256dh, b.keys.auth);
    expect(decrypt(body, b)).toBe('{"hi":1}');
  });

  it("sends an encrypted, VAPID-signed push and keeps keys at 0600", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webpush-"));
    const file = join(dir, "web-push.json");
    const posts: Array<{ endpoint: string; headers: Record<string, string>; body: Buffer }> = [];
    const push = new WebPush(file, () => true, async (endpoint, init) => { posts.push({ endpoint, ...init }); return { status: 201 }; });
    const b = browser();
    const endpoint = "https://fcm.googleapis.com/fcm/send/test-1";
    push.subscribe(OWNER, "session-1", { endpoint, keys: b.keys });
    await push.send(OWNER, { title: "Scout finished", body: "pushed the branch", tag: "msg:m1", data: { kind: "done", botId: "b1", threadId: "t1", messageId: "m1" } });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers["content-encoding"]).toBe("aes128gcm");
    const k = verifyVapid(posts[0]!.headers.authorization!, endpoint);
    expect(k).toBe(push.publicKey());
    expect(JSON.parse(decrypt(posts[0]!.body, b))).toMatchObject({ title: "Scout finished", data: { threadId: "t1", messageId: "m1" } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // the same key comes back after a restart
    expect(new WebPush(file).publicKey()).toBe(push.publicKey());
    expect(readFileSync(file, "utf8")).not.toContain("BEGIN");
  });

  it("forgets a subscription the push service says is gone, and skips revoked sessions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "webpush-"));
    let live = true;
    let status = 201;
    let sent = 0;
    const push = new WebPush(join(dir, "w.json"), () => live, async () => { sent++; return { status }; });
    push.subscribe(OWNER, "s1", { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: browser().keys });
    live = false;
    await push.send(OWNER, { title: "t", body: "b", data: {} });
    expect(sent).toBe(0);
    expect(push.countFor(OWNER)).toBe(0);
    live = true;
    push.subscribe(OWNER, "s1", { endpoint: "https://fcm.googleapis.com/fcm/send/b", keys: browser().keys });
    status = 410;
    await push.send(OWNER, { title: "t", body: "b", data: {} });
    expect(sent).toBe(1);
    expect(push.subscribed("https://fcm.googleapis.com/fcm/send/b")).toBe(false);
  });

  it("answers whether a browser is registered for this person and session, by endpoint hash", () => {
    const push = new WebPush(join(mkdtempSync(join(tmpdir(), "webpush-")), "w.json"), () => true, async () => ({ status: 201 }));
    const endpoint = "https://fcm.googleapis.com/fcm/send/h";
    const hash = createHash("sha256").update(endpoint).digest("hex");
    expect(push.holds(hash, OWNER, "s1")).toBe(false);
    push.subscribe(OWNER, "s1", { endpoint, keys: browser().keys });
    expect(push.holds(hash, OWNER, "s1")).toBe(true);
    expect(push.holds(hash, OWNER, "s2")).toBe(false);
    expect(push.holds(hash, "someone-else", "s1")).toBe(false);
  });

  it("refuses bad keys and a foreign session's unsubscribe", () => {
    const push = new WebPush(join(mkdtempSync(join(tmpdir(), "webpush-")), "w.json"), () => true, async () => ({ status: 201 }));
    expect(() => push.subscribe(OWNER, "s1", { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "short", auth: "x" } })).toThrow();
    push.subscribe(OWNER, "s1", { endpoint: "https://fcm.googleapis.com/x", keys: browser().keys });
    expect(push.unsubscribe("https://fcm.googleapis.com/x", "s2")).toBe(false);
    expect(push.unsubscribe("https://fcm.googleapis.com/x", "s1")).toBe(true);
  });

  it("trims a long body to fit, never the routing data", async () => {
    const b = browser();
    const bodies: Buffer[] = [];
    const push = new WebPush(join(mkdtempSync(join(tmpdir(), "webpush-")), "w.json"), () => true, async (_e, init) => { bodies.push(init.body); return { status: 201 }; });
    push.subscribe(OWNER, "s1", { endpoint: "https://fcm.googleapis.com/x", keys: b.keys });
    await push.send(OWNER, { title: "t", body: "é".repeat(5000), data: { threadId: "t1", messageId: "m1" } });
    const out = JSON.parse(decrypt(bodies[0]!, b));
    expect(out.data).toEqual({ threadId: "t1", messageId: "m1" });
    expect(bodies[0]!.length).toBeLessThan(4096);
  });
});
