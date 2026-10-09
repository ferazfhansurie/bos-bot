import assert from "node:assert/strict";
import test from "node:test";

import { sameWelcomeOrigin, welcomePermissionAllowed, welcomeWindowUrl } from "./welcome-window.mjs";

test("loads only https links on hi.aihlete.com or under bos.aihlete.com", () => {
  assert.equal(welcomeWindowUrl("https://hi.aihlete.com/pair#code=abc").origin, "https://hi.aihlete.com");
  assert.equal(welcomeWindowUrl("https://bos.aihlete.com/x").hostname, "bos.aihlete.com");
  for (const bad of [
    "http://hi.aihlete.com/pair",
    "https://evilbos.aihlete.com/pair",
    "https://watch.aihlete.com/pair",
    "https://hi.aihlete.com.evil.test/pair",
    "https://bos.aihlete.com.evil.test/pair",
    "https://user:pw@hi.aihlete.com/pair",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    42,
  ]) {
    assert.throws(() => welcomeWindowUrl(bad), String(bad));
  }
});

test("navigation stays on the welcome origin", () => {
  assert.equal(sameWelcomeOrigin("https://hi.aihlete.com/rooms/1", "https://hi.aihlete.com"), true);
  assert.equal(sameWelcomeOrigin("https://example.com/", "https://hi.aihlete.com"), false);
  assert.equal(sameWelcomeOrigin("garbage", "https://hi.aihlete.com"), false);
});

test("grants notifications and copy to the welcome origin only", () => {
  const origin = "https://hi.aihlete.com";
  assert.equal(welcomePermissionAllowed("notifications", `${origin}/x`, origin), true);
  assert.equal(welcomePermissionAllowed("clipboard-sanitized-write", origin, origin), true);
  assert.equal(welcomePermissionAllowed("media", `${origin}/x`, origin), false);
  assert.equal(welcomePermissionAllowed("notifications", "https://example.com/", origin), false);
});
