# Teaching recorder UI acceptance

Run only the dedicated fixture, with inherited bot capabilities removed:

```sh
node - <<'JS'
const { spawnSync } = require('node:child_process');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:BOSBOT_|BOS_|OMB_|OPENMAUSBOT_|AIOS_)/.test(key)));
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', 'scripts/testing/teaching-recorder-ui.e2e.test.ts'], { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
JS
```

This mounts the real TeachingRecorder and renderer store against a disposable
fake-engine server. The preview replaces getDisplayMedia with a canvas video
stream containing only the words `synthetic teaching step`. It never calls the
real screen picker and never captures the user's screen or microphone.

The test drives the actual buttons and notes: start, capture a step, enter a note,
stop and review, then send the reviewed screenshot and instructions. It holds the
attachment upload while changing the displayed task, proving the send stays pinned
to the reviewed thread. It reads both real fixture transcripts to confirm routing.
A fresh mount records and discards another synthetic capture, then checks all
video tracks ended, previews disappeared, and no screenshot upload happened.

The test prints a persistent `.teaching-proof.json` evidence path and leaves a
`.teaching-review.png` screenshot beside that file. Teardown closes its exact
browser session, Vite preview and disposable server. This proves the component
workflow and message routing; OS screen-picker permission and a real model's
skill proposal are separate acceptance steps.
