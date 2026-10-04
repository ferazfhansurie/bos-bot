import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const unavailable = (reason, message) => ({ available: false, reason, message });

// Package policy is build-time metadata, never a runtime environment override.
// Signing identity is deliberately irrelevant: local signed apps are packaged.
export function readUpdaterCapability({ isPackaged, staging, resourcesPath }) {
  if (!isPackaged || staging) {
    return unavailable("disabled", "Native updates are disabled for this build.");
  }
  try {
    const { bosUpdatePolicy: policy } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (policy?.mode === "offline") {
      return unavailable("offline", "Native updates are disabled for this local/offline package.");
    }
    if (policy?.mode !== "native") throw new Error("missing package policy");
    const expected = policy.feed;
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error("missing feed");
    let feedKeys;
    if (expected.provider === "github") {
      const name = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
      if (typeof expected.owner !== "string" || typeof expected.repo !== "string" || !name.test(expected.owner) || !name.test(expected.repo)) throw new Error("invalid github feed");
      feedKeys = ["provider", "owner", "repo"];
    } else if (expected.provider === "generic") {
      if (typeof expected.url !== "string") throw new Error("invalid generic feed");
      const url = new URL(expected.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("invalid generic feed");
      feedKeys = ["provider", "url"];
    } else {
      throw new Error("unsupported feed");
    }
    if (Object.keys(expected).some((key) => !feedKeys.includes(key))) throw new Error("unsupported feed option");

    // This parser-only bundle cannot initialize electron-updater or Squirrel.
    // Missing parser/metadata, malformed YAML, aliases, or mismatched feeds all
    // fail closed BEFORE loading the native updater, listeners, or timers.
    const text = readFileSync(join(resourcesPath, "app-update.yml"), "utf8");
    const { parseDocument } = require("./vendor/update-yaml.cjs");
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new Error("invalid metadata");
    const metadata = document.toJS({ maxAliasCount: 0 });
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error("invalid metadata");
    if (feedKeys.some((key) => metadata[key] !== expected[key])) throw new Error("feed mismatch");
    const allowed = new Set([...feedKeys, "updaterCacheDirName", "publisherName"]);
    if (Object.keys(metadata).some((key) => !allowed.has(key))) throw new Error("unsupported metadata option");
    if (typeof metadata.updaterCacheDirName !== "string" || !/^[A-Za-z0-9._-]+$/.test(metadata.updaterCacheDirName) || [".", ".."].includes(metadata.updaterCacheDirName)) throw new Error("invalid cache directory");
    if (metadata.publisherName !== undefined && !(typeof metadata.publisherName === "string" && metadata.publisherName.trim()) && !(Array.isArray(metadata.publisherName) && metadata.publisherName.length && metadata.publisherName.every((name) => typeof name === "string" && name.trim()))) throw new Error("invalid publisher");
    return { available: true, reason: "configured", metadata };
  } catch {
    return unavailable("unconfigured", "Native updates are unconfigured: this package needs valid update policy and matching feed metadata.");
  }
}
