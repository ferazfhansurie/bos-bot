import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  await runControlOmb(["new-bot", "--name", "Page fixture", "--url", fixture.info.url]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/pages-preview.tsx", route: "/__pages.html", title: "Isolated pages fixture" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally { await ui?.close(); await fixture.close(); }
