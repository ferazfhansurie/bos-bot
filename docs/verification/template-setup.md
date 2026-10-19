# Template install and connect

Run the isolated fixture, never the live workspace:

```sh
pnpm exec vitest run server/template-setup.e2e.test.ts server/team-package-skills.e2e.test.ts src/lib/bot-readiness.test.ts
```

The fixture starts a temporary fake-engine server with a disposable home. It imports a synthetic package with standing instructions, playbooks, selected skills, a routine, and connection requirements. It checks the stored overview and re-export, confirms routines and imported skills are disabled, and verifies unknown account/token fields do not survive the package boundary. It then removes the fixture.

Package requirements are setup intent only:

```json
{
  "apps": [{ "slug": "gmail", "label": "Gmail", "reason": "Read the daily brief." }],
  "capabilities": [],
  "tools": [{ "slug": "reports", "kind": "plugin", "label": "Reports", "reason": "Prepare reports.", "optional": true }]
}
```

Tool kinds are `browser`, `computer`, or `plugin`. No account ids, credentials, grants, or active schedule state are included. Unknown fields are stripped by the server parser. Existing packages without `tools` remain valid.

Catalog downloads, links and package files show the same import review. After import, the bot's overview checks declared requirements. Optional accounts remain optional; unrelated workspace connections do not block the template. App actions open the existing connection flow; plugin actions open Plugins → MCP servers. Browser/computer availability reflects configured access and engine support. Plugin and free-form capability requirements remain unverified until reviewed; this checklist does not claim a task succeeded.

The HTTP fixture proves the import/overview/export boundary. Renderer navigation and physical-device acceptance require separate UI checks. Nothing is published to the public catalog by this test.
