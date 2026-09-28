# Team setup and first assignment

Launch an isolated full-app fixture following [Chat UI](chat-ui.md):

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch --tool-calls '[]'
```

In a second terminal, pass its exact printed handle:

```sh
node --experimental-strip-types scripts/verify-recruitment-ui.ts /tmp/openmausbot-verify-data-XXXXXX/ui.json
```

To verify creation when no chief exists, launch another fresh fixture and run
the same recipe with `--missing-chief`. This deletes only that fixture's
seeded chief, then verifies setup creates a new coordinator and opens its
first assignment correctly. Evidence uses the `recruitment-missing-chief`
directory.

The recipe uses the real renderer and fake-engine server in the disposable
fixture. It renames only the fixture's seeded chief to Jarvis, marks welcome
completed, and opens **Settings → Set up my AI team**. It enters a business
brief, selects the ready fixture provider, starts the specialist assignment,
and verifies that the original chief receives the complete brief and setup
instructions. Reopening setup and resuming preserves the same send ID and
exact transcript, without another model turn. Existing bot identities and
chief authority remain intact.

Screenshots and the bounded assignment/snapshot record are retained in
`.omb-scratch/verify-evidence/recruitment/`. Keep the launcher's printed server
log path alongside the PASS output. Stop the launcher with Ctrl-C; it removes
only its own disposable fixture.

The fake provider proves UI transitions, prompt delivery and request recovery.
It does not execute specialist setup tools, prove provider authentication, or
verify the quality of a generated website, dashboard, CRM or motion graphic.
Authorized setup tools have their separate [team setup recipe](team-setup.md).

HTTP and component regression coverage:

```sh
pnpm exec vitest run server/bos-onboarding.e2e.test.ts server/onboarding-chief.test.ts
pnpm exec vitest run src/lib/onboarding.test.ts src/lib/first-assignment.test.ts shared/bos-onboarding.test.ts src/components/onboarding/RecruitmentWelcome.test.ts
```

The HTTP fixture covers a lost send response, saved-intent recovery,
read-only client redaction, coordinator endpoint authorization/idempotency,
and owner-supplied first-bot identity. A missing chief is created only by the
explicit owner setup action. An existing chief is reused without renaming or
demotion.

The older `verify-onboarding-ui.ts` recipe targets the legacy WelcomeFlow
profile/reel/phone sequence and is not the current recruitment acceptance
recipe. Guided tour coverage remains separate from team setup.
