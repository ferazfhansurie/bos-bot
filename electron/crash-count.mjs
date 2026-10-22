import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Best effort metadata for the next usage ping; failure cannot affect recovery. */
export function recordCrashCount(dataDir) {
  const file = path.join(dataDir, "crash-count.json");
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    let count = 0;
    try {
      handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024) return;
      const saved = JSON.parse(fs.readFileSync(handle, "utf8"));
      if (Number.isSafeInteger(saved.count) && saved.count >= 0) count = saved.count;
    } catch (error) {
      if (error.code !== "ENOENT") return;
    } finally {
      if (handle !== undefined) { fs.closeSync(handle); handle = undefined; }
    }
    fs.writeFileSync(temporary, JSON.stringify({ count: Math.min(count + 1, Number.MAX_SAFE_INTEGER), lastCrashAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch {
    // A read-only workspace must still be able to recover.
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}
