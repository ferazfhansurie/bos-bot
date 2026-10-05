import { createRequire } from "node:module";
import path from "node:path";
import { packagedSourceCommit, stampBuildCommitSync } from "./after-pack.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
// Use the builder's own signer to keep its retry policy and osx-sign version.
const { sign } = builderRequire("app-builder-lib/out/codeSign/macCodeSign.js");

export default async function signMac(options, packager) {
  const commit = packagedSourceCommit({ packager });
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
    throw new Error("mac signing needs the full 40-hex source commit");
  }
  const app = path.resolve(options.app);
  const resources = path.join(app, "Contents", "Resources");
  let stamped = false;
  await sign({
    ...options,
    optionsForFile(file) {
      const perFile = options.optionsForFile?.(file);
      if (path.resolve(file) === app) {
        // All children (including the PTY natives) now have final signed bytes.
        // Writing after signAsync returns would invalidate the app's signature.
        stampBuildCommitSync(resources, commit);
        stamped = true;
      }
      return perFile;
    },
  });
  if (!stamped) throw new Error("mac signer did not seal the build stamp");
}
