// Builds the phone's rich-block renderer (src/openui/embed) into one
// self-contained html file and copies it into the ios and android apps.
// The webviews load it from the app bundle, so nothing is fetched at run
// time. Run after changing SmartUi, the openui library, RichChart or
// RichStats: `pnpm build:smart-ui`.
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const root = join(repo, "src/openui/embed");
const out = mkdtempSync(join(tmpdir(), "bos-smart-ui-"));
const targets = [
  join(repo, "ios/App/SmartUI/smart-ui.html"),
  join(repo, "android/app/src/main/assets/smart-ui.html"),
];

// zod's `z` namespace re-exports all ~40 error locales, which no tree shaker
// can drop; the phone only ever shows english, so give it english alone
// (classic zod sets en itself, straight from locales/en.js).
const zodEnglishOnly = {
  name: "zod-english-only",
  enforce: "pre",
  resolveId(source, importer) {
    if (source === "../locales/index.js" && importer && /[\\/]zod[\\/]v4[\\/]classic[\\/]/.test(importer)) return "\0zod-locales";
  },
  load(id) {
    if (id === "\0zod-locales") return `export { default as en } from ${JSON.stringify(join(repo, "node_modules/zod/v4/locales/en.js"))};`;
  },
};

try {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    plugins: [zodEnglishOnly, react(), tailwindcss()],
    resolve: { alias: { "@": join(repo, "src") } },
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: out,
      emptyOutDir: true,
      modulePreload: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { output: { inlineDynamicImports: true } },
    },
  });
  const assets = join(out, "assets");
  const files = readdirSync(assets);
  const js = files.filter(f => f.endsWith(".js")).map(f => readFileSync(join(assets, f), "utf8"));
  const css = files.filter(f => f.endsWith(".css")).map(f => readFileSync(join(assets, f), "utf8"));
  if (js.length !== 1) throw new Error(`expected one script, got ${js.length}`);
  let html = readFileSync(join(out, "index.html"), "utf8")
    .replace(/<script type="module"[^>]*><\/script>\s*/g, "")
    .replace(/<link rel="stylesheet"[^>]*>\s*/g, "");
  // a literal </script> inside the bundle would end the inline tag early
  const script = js[0].replace(/<\/script/gi, "<\\/script");
  // function replacers: a string one would expand the $& and $' the
  // minified bundle is full of
  html = html
    .replace("</head>", () => `<style>${css.join("\n")}</style>\n</head>`)
    .replace("</body>", () => `<script type="module">${script}</script>\n</body>`);
  if (!html.includes(script)) throw new Error("bundle changed while inlining");
  for (const target of targets) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, html);
  }
  console.log(`smart-ui.html ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB → ${targets.map(t => t.slice(repo.length)).join(", ")}`);
} finally {
  rmSync(out, { recursive: true, force: true });
}
