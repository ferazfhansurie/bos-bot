// Two owners whose homes are linked kept swapping profile photos: a phone
// paired to the other person's Mac (as admin, so it looked like the owner)
// pushed its own photo on every connect, or cleared the photo when it had
// none. Each home's owner photo must stay that owner's own.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { MultiplayerLinks } from "./multiplayer-links.ts";

/** A tiny but valid-looking JPEG payload, distinct per person. */
const jpeg = (seed: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array.from({ length: 28 }, (_, i) => (seed * 31 + i) & 0xff), 0xff, 0xd9]).toString("base64");

it("keeps each linked owner's profile photo when the other owner's phone connects", async () => {
  const folder = mkdtempSync(join(tmpdir(), "omb-profile-photo-"));
  const fixtures: VerificationServer[] = [];
  const request = async (fixture: VerificationServer, method: string, path: string, body?: unknown, token?: string) => {
    const response = await fetch(new URL(path, fixture.info.url), { method,
      headers: { "content-type": "application/json", origin: fixture.info.url, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    return { status: response.status, body: await response.json() as any };
  };
  const homePhoto = async (fixture: VerificationServer) => (await request(fixture, "GET", "/api/multiplayer/home")).body.avatar as string | null;
  const firazPhoto = jpeg(1), pangPhoto = jpeg(2);
  try {
    for (let index = 0; index < 2; index++) fixtures.push(await launchVerificationServer());
    const [firaz, partner] = fixtures as [VerificationServer, VerificationServer];
    for (const [fixture, name, photo] of [[firaz, "Firaz", firazPhoto], [partner, "Partner", pangPhoto]] as const) {
      expect((await request(fixture, "PUT", "/api/config", { profile: { name } })).status).toBe(200);
      expect(await request(fixture, "PUT", "/api/multiplayer/profile-photo", { photo, expected: "" })).toMatchObject({ status: 200 });
      expect(await homePhoto(fixture)).toBe(`data:image/jpeg;base64,${photo}`);
    }

    // Firaz's home links Partner's, and sees Partner's own photo for Partner.
    const peer = await request(partner, "POST", "/api/auth/pairing", { scopes: ["peer"] });
    const peerSession = await request(partner, "POST", "/api/auth/pair", { code: peer.body.code });
    expect(peerSession.status).toBe(200);
    const fetcher: typeof fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://partner.example.org") throw new Error("unexpected fixture destination");
      return fetch(new URL(url.pathname + url.search, partner.info.url), init);
    };
    const links = new MultiplayerLinks(join(folder, "links.json"), "firaz-home", fetcher);
    await links.addVerified("https://partner.example.org", peerSession.body.token);
    expect(links.avatarForPerson("Partner")).toBe(`data:image/jpeg;base64,${pangPhoto}`);

    // Firaz's phone is paired to Partner's Mac with full access. Older phone
    // builds pushed the phone's own photo (or a clear) on every connect.
    const pairing = await request(partner, "POST", "/api/auth/pairing", { scopes: ["admin"] });
    const phone = await request(partner, "POST", "/api/auth/pair", { code: pairing.body.code, label: "Firaz's iPhone" });
    expect(phone.status).toBe(200);
    const pangUrl = (await request(partner, "GET", "/api/config")).body.profile.avatarUrl as string;
    expect(await request(partner, "PUT", "/api/multiplayer/profile-photo", { photo: firazPhoto }, phone.body.token))
      .toMatchObject({ status: 409, body: { avatarUrl: pangUrl } });
    expect(await request(partner, "PUT", "/api/multiplayer/profile-photo", { photo: null }, phone.body.token))
      .toMatchObject({ status: 409, body: { avatarUrl: pangUrl } });
    // A write naming a photo that is no longer current is stale, not explicit.
    expect(await request(partner, "PUT", "/api/multiplayer/profile-photo", { photo: firazPhoto, expected: "" }, phone.body.token))
      .toMatchObject({ status: 409 });
    expect(await homePhoto(partner)).toBe(`data:image/jpeg;base64,${pangPhoto}`);
    expect(await homePhoto(firaz)).toBe(`data:image/jpeg;base64,${firazPhoto}`);
    await links.refreshBots((await request(partner, "GET", "/api/multiplayer/me")).body.homeId);
    expect(links.avatarForPerson("Partner")).toBe(`data:image/jpeg;base64,${pangPhoto}`);

    // Partner's own explicit change still works, and touches only Partner's home.
    const newPang = jpeg(3);
    expect(await request(partner, "PUT", "/api/multiplayer/profile-photo", { photo: newPang, expected: pangUrl })).toMatchObject({ status: 200 });
    expect(await homePhoto(partner)).toBe(`data:image/jpeg;base64,${newPang}`);
    expect(await homePhoto(firaz)).toBe(`data:image/jpeg;base64,${firazPhoto}`);
  } finally {
    await Promise.allSettled(fixtures.map(fixture => fixture.close()));
    rmSync(folder, { recursive: true, force: true });
  }
}, 120_000);
