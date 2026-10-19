#!/usr/bin/env node
// Build one enterprise feed release from a packaged app's Resources:
//   node scripts/enterprise-publish.mjs --key <ed25519 pkcs8 pem> --out <dir>
//        [--resources "/Applications/BOS Bot.app/Contents/Resources"] [--version 2.0.3] [--channel enterprise]
// Writes <out>/bundle-<sha8>.tgz, manifest.json and manifest.sig. Upload all
// three to the feed (bundle first, manifest last) and a headless server can
// update itself on demand (server/enterprise-update.ts verifies the signature
// against FEED_PUBLIC_KEY there). server/vendor is left out: it holds
// mac-native modules a Windows or Linux server cannot load.
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  resources: { type: "string", default: "/Applications/BOS Bot.app/Contents/Resources" },
  key: { type: "string" }, out: { type: "string" }, version: { type: "string" }, channel: { type: "string", default: "enterprise" },
} });
const die = message => { console.error(`enterprise-publish: ${message}`); process.exit(1); };
if (!values.key || !values.out) die("--key and --out are required");
const resources = path.resolve(values.resources);
for (const name of ["server/index.js", "ui/index.html", "skills", "build-commit.json"]) if (!existsSync(path.join(resources, name))) die(`${resources} has no ${name}`);
const commit = JSON.parse(readFileSync(path.join(resources, "build-commit.json"), "utf8")).commit;
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) die("build-commit.json has no full commit");
const version = values.version ?? (() => {
  const plist = path.join(resources, "..", "Info.plist");
  const match = existsSync(plist) && /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(plist, "utf8"));
  return match ? match[1] : die("no --version and no Info.plist to read it from");
})();

const key = createPrivateKey(readFileSync(values.key));
const stage = mkdtempSync(path.join(tmpdir(), "bos-enterprise-"));
try {
  cpSync(path.join(resources, "server"), path.join(stage, "server"), { recursive: true, filter: src => path.relative(path.join(resources, "server"), src).split(path.sep)[0] !== "vendor" });
  for (const name of ["ui", "skills"]) cpSync(path.join(resources, name), path.join(stage, name), { recursive: true });
  cpSync(path.join(resources, "build-commit.json"), path.join(stage, "build-commit.json"));
  const out = path.resolve(values.out);
  mkdirSync(out, { recursive: true });
  const file = `bundle-${commit.slice(0, 8)}.tgz`;
  // COPYFILE_DISABLE keeps macOS tar from adding ._ AppleDouble files.
  execFileSync("tar", ["-czf", path.join(out, file), "-C", stage, "server", "ui", "skills", "build-commit.json"], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  const archive = readFileSync(path.join(out, file));
  const manifest = { schema: 1, channel: values.channel, version, commit, publishedAt: new Date().toISOString(),
    bundle: { file, sha256: createHash("sha256").update(archive).digest("hex"), size: statSync(path.join(out, file)).size } };
  const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(out, "manifest.json"), body);
  writeFileSync(path.join(out, "manifest.sig"), `${sign(null, body, key).toString("base64")}\n`);
  const pub = createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  console.log(JSON.stringify({ out, version, commit, bundle: file, size: manifest.bundle.size, publicKey: pub }));
} finally { rmSync(stage, { recursive: true, force: true }); }
