import { compatEnv } from "../../electron/branding-env.cjs";
// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.openmausbot) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { removeTempDir } from "./cleanup.ts";

// The test runner may itself be launched by a live bot. Strip every product
// alias before importing application modules or spawning fixture children.
// Per-test fixtures can then explicitly install only their own capabilities.
for (const key of Object.keys(process.env)) {
  if (/^(?:BOSBOT_|BOS_|OMB_|OPENMAUSBOT_|AIOS_)/.test(key)) delete process.env[key];
}

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
compatEnv.HOME = home;
compatEnv.USERPROFILE = home;
// OMB_DATA_DIR is an intentional production override, but tests must never
// let it escape the throwaway home they are about to delete.
delete compatEnv.OMB_DATA_DIR;
// Disposable fixtures must never contribute launch usage counts.
compatEnv.BOS_NO_PING = "1";
// Do not let a developer's Hermes global config path leak into per-test homes.
delete compatEnv.HERMES_HOME;
// The companion keeps its paired devices in its own directory, and resolves
// it from homedir() the same way — so the redirect above already covers it.
// Named explicitly all the same: the device tests delete this directory
// wholesale, and "it is safe because of a line in another file" is not the
// footing that delete should stand on.
compatEnv.OMB_COMPANION_DIR = join(home, ".openmausbot-companion");

// Product code follows navigator.language, which makes English assertions
// depend on the developer or CI host locale. Keep the shared default stable;
// dedicated i18n tests explicitly select every translated pack they exercise.
Object.defineProperty(globalThis.navigator, "language", { value: "en", configurable: true });

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
// branding compatibility (electron/branding-compat.json): data-home: existing desktop and companion homes, backups and lease recovery must open the same data; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
