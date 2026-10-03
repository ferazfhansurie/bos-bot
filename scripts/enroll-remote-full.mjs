#!/usr/bin/env node
// Interactive enrollment on the server host. Verified account + exact server
// credential/key + independently reviewed CP permit form the authority boundary.
// TTY avoids code logging; no secrets on argv/env or BOS HTTP. Starts no turn.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { enrollRemoteFullOwner } from "./remote-full-enrollment.mjs";
import { createControlPlaneClient } from "../electron/control-plane-client.mjs";
import { controlPlaneUnavailableReason, resolveCompanionControlPlaneURL } from "../electron/companion-account-service.mjs";
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
// Same authority the server checks (BOS_CONTROL_PLANE_URL); no hosted default.
const controlPlane = resolveCompanionControlPlaneURL({ environment: process.env });
if (!controlPlane) { console.error(controlPlaneUnavailableReason(process.env)); process.exit(1); }
const client = createControlPlaneClient({ baseURL: controlPlane });
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
  let previous;
  try { previous = JSON.parse(readFileSync(file, "utf8")); } catch (e) { if (e.code !== "ENOENT") throw new Error("Existing enrollment is unreadable; recover it before retrying"); }
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
  const enrollment = await enrollRemoteFullOwner({ client, account, previous, environmentId, audience: audience.origin,
    platform: process.platform === "win32" ? "windows" : process.platform,
    confirm: async ({ statement, isNew, installationId }) => {
      console.log(isNew ? "NEW owner enrollment: creates a separate installation. It cannot adopt or rotate an existing installation." : `Verify existing server installation: ${installationId}. Its credential will not rotate.`);
      console.log("This explicitly establishes ownership of this server. Profile names, pairing, team membership and provider logins are not ownership proof.");
      return rl.question(`The human server owner must confirm this exact statement:\n${statement}\n> `);
    },
    reviewScope: async (scope) => {
      console.log("Public enrollment scope for independent control-plane ownership review (no credentials):");
      console.log(JSON.stringify(scope, null, 2));
      console.log("A matching unexpired control-plane operator permit is required. Without one this remains pending; retry the same saved enrollment after review.");
    },
    persist: async (value) => {
      const temporary = join(dir, `${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
        const fd = openSync(temporary, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
        // Exclusive publication: a concurrent enrollment must not overwrite
        // any existing or newly saved credential.
        linkSync(temporary, file);
      } finally { try { unlinkSync(temporary); } catch {} }
    },
  });
  console.log(`Enrolled installation ${enrollment.installationId}. On the paired Mac open the target task → Full access… and sign in as this owner. No tasks were started.`);
} catch { console.error("Enrollment did not complete. Check this server's owner account and existing enrollment; no credentials are printed. Retry retained pending enrollment with the same owner. Lost or revoked credentials require separately reviewed recovery; this command never rotates them."); process.exitCode = 1; }
finally { if (ownerSession) await client.signOut(ownerSession).catch(() => {}); rl.close(); }
