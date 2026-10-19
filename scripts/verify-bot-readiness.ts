import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
const ui = await mountPreview(fixture, { entry: "/src/testing/bot-readiness.tsx", route: "/__bot-readiness.html", title: "Isolated Readiness" });
try {
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }));
  await parkUntilSignal();
} finally {
  await ui.close();
  await fixture.close();
}
