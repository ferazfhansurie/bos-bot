import { expect, it } from "vitest";
import { launchVerificationServer } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";
import { parseBotPackage } from "./bot-package.ts";
import { teamImportPreview } from "../src/lib/team-import.ts";

it("imports a complete template with setup intent, no authority and paused routines, then re-exports it", async () => {
  const fixture = await launchVerificationServer();
  const url = fixture.info.url;
  const post = (path: string, body: unknown) => request(path, { method: "POST", body: JSON.stringify(body) }, url);
  const instructions = "---\nname: fixture-plan\ndescription: Plan the fixture.\n---\nReturn a bounded plan.\n";
  const document = {
    format: "openmaus.package", version: 1,
    package: {
      id: "setup-fixture", release: "1.0.0", name: "Setup fixture", tagline: "Fixture only.",
      summary: "A complete isolated template.", category: "Testing", author: { name: "Fixture" }, license: "MIT",
      outcomes: ["Import safely."], setupMinutes: 3,
      requirements: {
        apps: [{ slug: "gmail", label: "Gmail", reason: "Read your brief." }, { slug: "slack", label: "Slack", reason: "Optional updates.", optional: true }],
        capabilities: ["image-generation"],
        tools: [{ slug: "fixture-plugin", kind: "plugin", label: "Fixture plugin", reason: "Prepare the report.", token: "DO_NOT_COPY" }],
        accountId: "DO_NOT_COPY", token: "DO_NOT_COPY",
      },
      agents: [{ key: "planner", name: "Template planner", soul: "Make a bounded plan.", appearance: { color: "cyan" }, skills: ["fixture-plan"], playbooks: ["plan"], composio: true }],
      playbooks: [{ key: "plan", name: "Plan", summary: "A plan.", triggers: ["plan"], instructions: "Prepare a bounded plan." }],
      skills: { version: 1, entries: [{ name: "fixture-plan", description: "Plan the fixture.", instructions }] },
      routines: [{ key: "daily", name: "Daily plan", agent: "planner", prompt: "Plan the day.", runOn: "maus", schedule: { type: "daily", time: "09:00", weekdays: [1] }, durationMinutes: 5, enabledAfterInstall: false }],
    },
  };
  try {
    const preview = teamImportPreview(document);
    expect(preview).toMatchObject({ playbooks: 1, routines: 1, skills: ["fixture-plan"], routineNames: ["Daily plan"], instructions: [{ name: "Template planner", text: "Make a bounded plan." }] });
    const imported = await post("/api/teams/import", document);
    const bot = imported.bots[0];
    expect(bot.composio).toBe(false);
    expect(imported.routines).toMatchObject([{ enabled: false, nextRunAt: null }]);
    const overview = await request(`/api/bots/${bot.id}/overview`, {}, url);
    expect(overview.requirements).toMatchObject({ requiredApps: document.package.requirements.apps, requiredCapabilities: ["image-generation"], requiredTools: [{ slug: "fixture-plugin", kind: "plugin" }] });
    expect(JSON.stringify(overview.requirements)).not.toContain("DO_NOT_COPY");
    const skills = await request(`/api/bots/${bot.id}/skills`, {}, url);
    expect(skills.skills).toMatchObject([{ name: "fixture-plan", enabled: false }]);
    const exported = await post("/api/teams/export", { format: "package", skillIds: ["fixture-plan"] });
    const pkg = parseBotPackage(exported.markdown).package;
    expect(pkg.requirements).toMatchObject({ apps: document.package.requirements.apps, capabilities: ["image-generation"], tools: [{ slug: "fixture-plugin", kind: "plugin" }] });
    expect(pkg.routines?.[0]?.enabledAfterInstall).toBe(false);
    expect(exported.markdown).not.toContain("DO_NOT_COPY");
    console.log(JSON.stringify({ ok: true, importedBot: bot.id, requirementsRetained: true, routinesPaused: true, credentialsStripped: true, fixture: fixture.info }));
  } finally { await fixture.close(); }
}, 90_000);
