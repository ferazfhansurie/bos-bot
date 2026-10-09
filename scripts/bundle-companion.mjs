// Keep the packaged sidecar self-contained, including environment aliases.
import { build } from "esbuild";
await build({
  entryPoints: ["companion/src/index.ts"],
  outfile: "dist-companion/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: { js: 'import { createRequire as __bosCreateRequire } from "node:module"; const require = __bosCreateRequire(import.meta.url);' },
});
