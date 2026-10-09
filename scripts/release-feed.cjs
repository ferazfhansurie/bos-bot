const { compatEnv, compatEnvironment } = require("../electron/branding-env.cjs");
// Release-build inputs shared by electron-builder.live.cjs and
// scripts/release-contract.mjs, so the packaged app-update.yml and the
// contract that verifies it can never disagree.
//
// Update feed (baked into app-update.yml at build time, never read at runtime):
//   default                         github firazfhansurie/bos-bot (must be PUBLIC:
//                                   installed apps fetch it with no token)
//   BOS_UPDATE_GITHUB_OWNER/_REPO   another public github releases repo
//   BOS_UPDATE_FEED_URL             https base URL of a generic static feed
//                                   (latest.yml, latest-mac.yml, installers)
//
// Windows signing (BOS_WINDOWS_SIGNING):
//   signed    forceCodeSigning + signtool publisher + update signature check
//   unsigned  1.0 alpha: no cert, and no publisherName in app-update.yml, so
//             electron-updater installs updates without an Authenticode check.
//             Integrity rests on the HTTPS feed and latest.yml's sha512.
//   unset     signed (fail closed). The release workflow sets it explicitly.
'use strict';

const DEFAULT_FEED = Object.freeze({ provider: 'github', owner: 'firazfhansurie', repo: 'bos-bot' });
const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

function value(env, key) {
  const text = compatEnvironment(env)[key];
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

function releaseFeed(env = compatEnv) {
  const url = value(env, 'BOS_UPDATE_FEED_URL');
  const owner = value(env, 'BOS_UPDATE_GITHUB_OWNER');
  const repo = value(env, 'BOS_UPDATE_GITHUB_REPO');
  if (url && (owner || repo)) throw new Error('set BOS_UPDATE_FEED_URL or BOS_UPDATE_GITHUB_OWNER/REPO, not both');
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('BOS_UPDATE_FEED_URL is not a valid URL'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('BOS_UPDATE_FEED_URL must be a plain https URL with no credentials, query or fragment');
    }
    return { provider: 'generic', url: parsed.href.replace(/\/+$/, '') };
  }
  if (!owner && !repo) return { ...DEFAULT_FEED };
  const feed = { provider: 'github', owner: owner ?? DEFAULT_FEED.owner, repo: repo ?? DEFAULT_FEED.repo };
  if (!NAME.test(feed.owner) || !NAME.test(feed.repo)) throw new Error('invalid BOS_UPDATE_GITHUB_OWNER/REPO');
  return feed;
}

function windowsSigning(env = compatEnv) {
  const mode = value(env, 'BOS_WINDOWS_SIGNING') ?? 'signed';
  if (mode !== 'signed' && mode !== 'unsigned') throw new Error('BOS_WINDOWS_SIGNING must be "signed" or "unsigned"');
  return mode;
}

module.exports = { DEFAULT_FEED, releaseFeed, windowsSigning };
