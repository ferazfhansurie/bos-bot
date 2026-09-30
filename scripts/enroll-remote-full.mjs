#!/usr/bin/env node
// Interactive enrollment on the server host. Account verification is the
// authority boundary; a TTY merely avoids unattended code logging. No tokens
// or OTP on argv/env/HTTP. Does not start a server or turn.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createControlPlaneClient } from "../electron/control-plane-client.mjs";
const args = process.argv.slice(2);
if (!process.stdin.isTTY || !process.stdout.isTTY || args.length !== 2) {
  console.error("Run interactively on the server host: node scripts/enroll-remote-full.mjs <existing-data-dir> <https-origin>"); process.exit(1);
}
const dataDir = resolve(args[0]), audience = new URL(args[1]);
if (audience.protocol !== "https:" || audience.origin !== args[1] || audience.username || audience.password) throw new Error("Exact HTTPS origin required");
const environmentId = readFileSync(join(dataDir, "environment-id"), "utf8").trim();
if (!/^[a-f0-9-]{36}$/i.test(environmentId)) throw new Error("Existing server environment required");
let muted = false;
const output = new Writable({ write(chunk, _encoding, done) { if (!muted) process.stdout.write(chunk); done(); } });
const rl = createInterface({ input: process.stdin, output, terminal: true });
const client = createControlPlaneClient({ baseURL: "https://accounts.openmausbot.com" });
const dir = join(dataDir, ".remote-full"), file = join(dir, "owner.json");
let ownerSession;
try {
  console.log(`Enroll remote Full owner for ${audience.origin}\nEnvironment: ${environmentId}\nUse the server owner's BOS account. Existing pairing and providers will not change.`);
  const email = (await rl.question("Owner email: ")).trim();
  await client.requestOTP(email);
  process.stdout.write("Email code (hidden): "); muted = true;
  let otp;
  try { otp = await rl.question(""); } finally { muted = false; process.stdout.write("\n"); }
  const account = await client.verifyOTP(email, otp); ownerSession = account.accountToken; otp = "";
  const installations = await client.listInstallations(account.accountToken);
  let previous;
  try { previous = JSON.parse(readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("Existing enrollment is unreadable; recover it before retrying"); }
  if (previous && (previous.environmentId !== environmentId || previous.audience !== audience.origin || !installations.some(i => i.id === previous.installationId))) throw new Error("Existing enrollment belongs to a different owner or server; no change made");
  let existing = installations.find(i => i.id === previous?.installationId || i.clientInstanceId === environmentId);
  if (!existing && installations.length) {
    console.log("Your existing installations (credentials are never displayed):");
    for (const item of installations) console.log(`${item.id}  ${item.name}  ${item.platform}`);
    const choice = (await rl.question("Enter the ID for this server, or NEW if none is this server: ")).trim();
    if (choice !== "NEW") { existing = installations.find(i => i.id === choice); if (!existing) throw new Error("Unknown installation"); }
  }
  console.log(existing ? `Existing installation: ${existing.id}. Recovery may rotate only this server's installation credential.` : "A new installation record will be created under this owner.");
  if (await rl.question("Type ENROLL to confirm this exact server: ") !== "ENROLL") throw new Error("Cancelled");
  const enrollment = await client.ensureInstallation({ accountToken: account.accountToken, clientInstanceId: existing?.clientInstanceId ?? environmentId,
    currentCredential: previous?.credential, name: audience.hostname, platform: process.platform === "win32" ? "windows" : process.platform, appVersion: "remote-full-v1" });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") {
    const owner = execFileSync("whoami.exe", [], { encoding: "utf8", windowsHide: true }).trim();
    execFileSync("icacls.exe", [dir, "/inheritance:r", "/grant:r", `${owner}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F"], { stdio: "pipe", windowsHide: true });
    // /grant:r does not remove an unrelated explicit ACE on an existing
    // directory. Refuse such a directory before writing any new secret.
    execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$p=[Console]::In.ReadToEnd(); $u=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath $p -ErrorAction Stop; foreach($r in $a.Access) { if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($u,'S-1-5-18')) { throw 'Unexpected enrollment access rule' } }"],
      { input: dir, stdio: "pipe", windowsHide: true });
  } else { chmodSync(dir, 0o700); }
  const temporary = join(dir, `${randomUUID()}.tmp`);
  try {
    const privateKey = previous?.privateKey ?? generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" });
    writeFileSync(temporary, JSON.stringify({ privateKey, environmentId, installationId: enrollment.installation.id, audience: audience.origin, credential: enrollment.credential }), { mode: 0o600, flag: "wx" });
    const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, file);
  } finally { try { unlinkSync(temporary); } catch {} }
  console.log(`Enrolled installation ${enrollment.installation.id}. On the paired Mac open the target task → Full access… and sign in as this owner. No tasks were started.`);
} catch { console.error("Enrollment did not complete. Check this server's owner account and existing enrollment; no credentials are printed. A newly created installation may need recovery with the same owner account."); process.exitCode = 1; }
finally { if (ownerSession) await client.signOut(ownerSession).catch(() => {}); rl.close(); }
