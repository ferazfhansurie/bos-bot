const { compatEnv } = require("./electron/branding-env.cjs");
// Live distribution. The update feed and the Windows signing mode come from
// scripts/release-feed.cjs (see there for the env inputs).
//
// BOS_WINDOWS_SIGNING=unsigned is the 1.0 alpha Windows build: no cert, so
// forceCodeSigning is off and verifyUpdateCodeSignature is false, which keeps
// publisherName out of app-update.yml (electron-updater then skips the
// Authenticode check instead of rejecting every unsigned update). Unset or
// "signed" keeps the fail-closed signed build. Only `--win` builds may run
// unsigned; release-contract.mjs refuses the mode for mac and linux.
//
// Composed from the parsed base config instead of `extends`: electron-builder
// appends a child's `publish` list to the parent's, and app-update.yml takes
// the first entry, so an `extends` override could never move the feed.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { parse } = require('yaml');
const { releaseFeed, windowsSigning } = require('./scripts/release-feed.cjs');

const base = parse(readFileSync(join(__dirname, 'electron-builder.yml'), 'utf8'));
const feed = releaseFeed(compatEnv);
const unsignedWindows = windowsSigning(compatEnv) === 'unsigned';

module.exports = {
  ...base,
  extraMetadata: { ...base.extraMetadata, bosChannel: 'live', name: 'bos-bot', bosUpdatePolicy: { mode: 'native', feed } },
  publish: [feed],
  forceCodeSigning: !unsignedWindows,
  win: {
    ...base.win,
    ...(unsignedWindows
      ? { verifyUpdateCodeSignature: false }
      : { signtoolOptions: { publisherName: compatEnv.BOS_WINDOWS_PUBLISHER }, verifyUpdateCodeSignature: true }),
  },
};
