import { compatEnv } from "./electron/branding-env.cjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The About dialog shows the shipped version; package.json is the one place
// it is already maintained, so it is inlined at build time rather than
// round-tripped through the preload bridge (which is absent in dev).
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      // the notch (electron/notch.mjs) is its own small page
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        notch: fileURLToPath(new URL("./notch.html", import.meta.url)),
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    // Cloud rooms (bos 2.0) stay off unless the build opts in.
    __BOS_CLOUD_ROOMS__: JSON.stringify(compatEnv.BOS_CLOUD_ROOMS === "1"),
    // bos bot 3.0: BOS_V3=1 forces it on, BOS_V3=0 forces it off, unset
    // leaves it to the labs switch in settings.
    __BOS_V3__: JSON.stringify(compatEnv.BOS_V3 === "1" ? true : compatEnv.BOS_V3 === "0" ? false : null),
  },
  test: {
    environment: "node",
    include: [
      "server/**/*.test.ts",
      "electron/**/*.test.mjs",
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
      "companion/**/*.test.ts",
      "enterprise/**/*.test.ts",
      "scripts/**/*.test.mjs",
      "scripts/**/*.test.ts",
      "standalone/**/*.test.mjs",
    ],
    // node:test suites; `pnpm test:scripts` runs them under node --test.
    exclude: [...configDefaults.exclude, "scripts/bos-readiness.test.mjs", "scripts/enterprise-export-bot.test.mjs", "scripts/linux-package-contract.test.mjs", "scripts/release-contract.test.mjs", "scripts/release-stage.test.mjs"],
    setupFiles: ["server/testing/setup.ts"],
    // the suite spawns fake provider CLIs and a real harness server;
    // parallel files introduce load-sensitive flakes for no win
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    // IPv4 explicitly — a bare ::1 bind makes localhost a coin-flip for
    // clients that resolve IPv4 first
    host: "127.0.0.1",
    port: Number(compatEnv.OMB_UI_PORT) || 5199,
    // packager output lands inside the repo — its HTML files must never
    // trigger dev full-page reloads
    watch: {
      ignored: ["**/release/**", "**/build/**", "**/dist/**", "**/electron/resources/**"],
    },
    // the harness server owns every provider process; the app only ever
    // talks to /api — clients hold no transports
    proxy: {
      // cloud rooms sign in against the local control-plane issuer on this
      // origin, so its session cookie is same-site with /v2. Listed before
      // /api because the first matching prefix wins.
      ...(compatEnv.BOS_CLOUD_ROOMS === "1"
        ? { "/api/auth": { target: compatEnv.CLOUD_ISSUER_URL || "http://127.0.0.1:8787" } }
        : {}),
      "/api": {
        target: `http://127.0.0.1:${compatEnv.OMB_PORT || compatEnv.OGB_PORT || 8799}`,
        // the built-in terminal speaks a websocket on /api/terminal
        ws: true,
      },
      "/.well-known/openmausbot/environment": {
        target: `http://127.0.0.1:${compatEnv.OMB_PORT || compatEnv.OGB_PORT || 8799}`,
      },
      // the local cloud room test server, only when cloud rooms are on
      ...(compatEnv.BOS_CLOUD_ROOMS === "1"
        ? { "/v2": { target: compatEnv.BOS_CLOUD_URL || "http://127.0.0.1:8790", ws: true } }
        : {}),
    },
  },
});
// branding compatibility (electron/branding-compat.json): peer-http: HTTP authentication headers, discovery and domain verification still interoperate with 1.9.1; environment-aliases: legacy launchd/systemd and provider subprocess environment labels stay accepted; the central resolver always prefers the new spelling
