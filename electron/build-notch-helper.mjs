// Build the notch helper (electron/resources/notch-helper.swift) as one
// universal command-line binary. It needs no privacy permission, so unlike the
// speech helper it is not an app bundle. electron-builder replaces the ad-hoc
// signature when it signs the distribution.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const resourcesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "resources");

export const notchHelperSource = path.join(resourcesDir, "notch-helper.swift");
export const notchHelperBinary = path.join(resourcesDir, "notch-helper");

export function buildNotchHelper() {
  // macos12 is the app's floor and the first release with auxiliaryTop*Area
  const slices = ["arm64", "x86_64"].map((arch) => {
    const slice = `${notchHelperBinary}-${arch}`;
    execFileSync("swiftc", ["-O", "-target", `${arch}-apple-macos12`, notchHelperSource, "-o", slice], {
      stdio: "inherit",
      timeout: 120_000,
    });
    return slice;
  });
  execFileSync("lipo", ["-create", ...slices, "-output", notchHelperBinary], { stdio: "inherit", timeout: 60_000 });
  for (const slice of slices) rmSync(slice, { force: true });
  const archs = execFileSync("lipo", ["-archs", notchHelperBinary], { timeout: 60_000 }).toString();
  if (!archs.includes("arm64") || !archs.includes("x86_64")) throw new Error(`notch helper is not universal: ${archs.trim()}`);
  execFileSync("codesign", ["--force", "--sign", "-", "--options", "runtime", notchHelperBinary], {
    stdio: "inherit",
    timeout: 30_000,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildNotchHelper();
}
