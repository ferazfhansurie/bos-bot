#!/usr/bin/env node
// Deployment preparation only. Reads the existing peer binding; never mints
// sessions, grants Full Access, changes accounts, or writes the live grant.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
const args = process.argv.slice(2);
const value = name => { const at = args.indexOf(name); if (at < 0 || !args[at + 1]) throw new Error(`Required: ${name}`); return args[at + 1]; };
const dataDir = resolve(value("--data-dir"));
const output = resolve(value("--out"));
const read = file => JSON.parse(readFileSync(file, "utf8"));
const homeId = readFileSync(join(dataDir, "environment-id"), "utf8").trim();
const validId = id => typeof id === "string" && /^[\w-]{1,128}$/.test(id);
let result;
if (args[0] === "binding") {
  const targetHomeId = value("--target-home");
  const granteeBotId = value("--chief");
  if (![targetHomeId, granteeBotId, homeId].every(validId)) throw new Error("Invalid home/chief identity");
  const source = read(join(dataDir, "multiplayer-links.json"));
  const links = source.links?.filter(link => link.homeId === targetHomeId);
  if (links?.length !== 1 || !/^omb_sess_[A-Za-z0-9_-]{43}$/.test(links[0].token)) throw new Error("Exactly one existing peer link is required");
  result = { version: 1, targetHomeId, granteeHomeId: homeId, granteeBotId, peerTokenHash: createHash("sha256").update(links[0].token).digest("hex") };
} else if (args[0] === "grant") {
  const binding = read(value("--binding"));
  if (binding.version !== 1 || binding.targetHomeId !== homeId || ![binding.granteeHomeId, binding.granteeBotId].every(validId) || !/^[a-f0-9]{64}$/.test(binding.peerTokenHash)) throw new Error("Binding does not match this server");
  const matches = read(join(dataDir, "sessions.json")).sessions?.filter(session => session.tokenHash === binding.peerTokenHash && session.expiresAt > Date.now() &&
    session.scopes?.length === 1 && session.scopes[0] === "peer");
  if (matches?.length !== 1) throw new Error("Binding must match exactly one live peer-only session");
  if (output === resolve(join(dataDir, "delegations.json"))) throw new Error("Write a draft outside live delegations.json; install only after deploy approval");
  let previous;
  try { previous = read(join(dataDir, "delegations.json")); } catch (error) { if (error.code !== "ENOENT") throw error; previous = { version: 1, delegations: [] }; }
  const validEntry = item => item && [item.granteeHomeId, item.granteeBotId, item.peerSessionId].every(validId) &&
    typeof item.peerTokenHash === "string" && /^[a-f0-9]{64}$/.test(item.peerTokenHash) && Array.isArray(item.scopes) && item.scopes.length > 0 && item.scopes.length <= 4 &&
    item.scopes.every(scope => ["coordinate", "bots:create", "bots:delete", "bots:configure"].includes(scope)) && typeof item.section === "string" && item.section.length <= 60 &&
    typeof item.note === "string" && item.note.length <= 500 && (item.autoApply === undefined || typeof item.autoApply === "boolean") &&
    (item.expiresAt === undefined || (Number.isFinite(item.expiresAt) && item.expiresAt > 0)) &&
    Object.keys(item).every(key => ["granteeHomeId", "granteeBotId", "peerSessionId", "peerTokenHash", "scopes", "section", "note", "autoApply", "expiresAt"].includes(key));
  if (previous.version !== 1 || Object.keys(previous).some(key => !["version", "delegations"].includes(key)) || !Array.isArray(previous.delegations) || !previous.delegations.every(validEntry)) throw new Error("Existing delegation file is invalid; refusing to replace it");
  const entry = { granteeHomeId: binding.granteeHomeId, granteeBotId: binding.granteeBotId, peerSessionId: matches[0].id, peerTokenHash: binding.peerTokenHash,
    scopes: ["coordinate", "bots:create", "bots:delete", "bots:configure"], section: "", note: "authorized by partner via firaz 2026-09-30", autoApply: false };
  result = { version: 1, delegations: [...previous.delegations.filter(item => item.granteeHomeId !== entry.granteeHomeId || item.granteeBotId !== entry.granteeBotId), entry] };
} else throw new Error("Use binding or grant");
// Refuse an existing output; no accidental overwrite of another session's work.
const descriptor = openSync(output, "wx", 0o600);
try { writeFileSync(descriptor, JSON.stringify(result, null, 2) + "\n"); } finally { closeSync(descriptor); }
console.log(`Prepared ${args[0]} draft: ${output}. No live delegation changed.`);
