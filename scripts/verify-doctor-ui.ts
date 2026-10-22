// Real Settings → Health, backed only by a disposable fake-engine workspace.
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";
const fixture = await launchVerificationServer(undefined, undefined, undefined, undefined, undefined, undefined, [], undefined, undefined, 120_000);
let ui: MountedPreview | undefined;
try {
  const health = await fetch(`${fixture.info.url}/api/doctor`).then(async response => {
    if (!response.ok) throw new Error(`Doctor HTTP ${response.status}`);
    return response.json();
  });
  if (health.checks.length !== 7) throw new Error("Doctor did not return all seven checks");
  const refused = await fetch(`${fixture.info.url}/api/doctor/fix`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "delete-data" }) });
  if (refused.status !== 400) throw new Error("Doctor accepted an unknown repair action");
  ui = await mountPreview(fixture, { entry: "/scripts/testing/doctor-preview.tsx", route: "/__doctor.html", title: "BOS health · isolated fixture" });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl, health, unknownFixStatus: refused.status }));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
