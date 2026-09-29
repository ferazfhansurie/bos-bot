import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { packageUrlFromCommandLine, packageUrlFromDeepLink } from "./package-link.mjs";
import { PACKAGE_SCHEME } from "./release-channel.mjs";

describe("BotMRR package deep links", () => {
  it("accepts a public GitHub package URL", () => {
    const target = "https://raw.githubusercontent.com/acme/bots/main/reddit-lead-miner.md";
    assert.equal(packageUrlFromDeepLink(`${PACKAGE_SCHEME}://install?url=${encodeURIComponent(target)}`), target);
    assert.equal(packageUrlFromCommandLine(["BOS Bot", "--flag", `${PACKAGE_SCHEME}://install?url=${encodeURIComponent(target)}`]), target);
  });

  it("rejects other commands, hosts, protocols, credentials, and unsupported file types", () => {
    assert.equal(packageUrlFromDeepLink(`${PACKAGE_SCHEME}://settings`), null);
    assert.equal(packageUrlFromDeepLink(`${PACKAGE_SCHEME}://install?url=https://evil.example/bot.json`), null);
    assert.equal(packageUrlFromDeepLink(`${PACKAGE_SCHEME}://install?url=http://raw.githubusercontent.com/a/b/main/bot.json`), null);
    assert.equal(packageUrlFromDeepLink(`${PACKAGE_SCHEME}://install?url=https://user@example.com/bot.json`), null);
    assert.equal(packageUrlFromDeepLink(`${PACKAGE_SCHEME}://install?url=https://github.com/acme/bot/run.sh`), null);
    const otherChannel = PACKAGE_SCHEME === "bosbot" ? "bosbot-staging" : "bosbot";
    assert.equal(packageUrlFromDeepLink(`${otherChannel}://install?url=https://github.com/acme/bot/bot.json`), null);
  });
});
