# Automatic skills

After a person-started 1:1 turn with 8+ tool calls, the bot's one-shot
(`generateText`) reads the run and answers SKIP or one SKILL.md. Full access
applies it with a receipt card; otherwise a review card appears. The switch is
`features.autoSkills` (Skills settings, "Learn skills automatically"), on
whenever skill authoring is on. Caps: 3 drafts and 10 attempts per bot per
local day, in `<data>/auto-skills.json`, and no new draft while 3 auto drafts
wait on cards or the workspace is over its spend limit. Only the owner's own
lines count (no peer asks, guests, members, drained peer lines or sign-in
replays). A run that used web, browser, connected-app or curl/url tools gets a
review card even under full access. The card is skipped if the thread is busy
or a newer turn started while the draft was thinking.

## Driving it

The fake Claude CLI scripts both halves: `FAKE_CLAUDE_TOOL_CALLS` gives the
turn its tool calls and `FAKE_CLAUDE_TEXT_FILE` is the one-shot's reply (read
fresh on every call, so edit it between turns to change the drafted name).
`FAKE_CLAUDE_TEXT_DUMP` keeps the distill prompt.

```sh
python3 -c 'import json;print(json.dumps([{"name":"Bash","input":{"command":f"shop orders --since 7d # {i}"}} for i in range(9)]))' > /tmp/as-tools.json
# /tmp/as-skill.md: a SKILL.md with frontmatter name weekly-sales-report
FAKE_CLAUDE_TOOL_CALLS="$(cat /tmp/as-tools.json)" FAKE_CLAUDE_TEXT_FILE=/tmp/as-skill.md \
FAKE_CLAUDE_TEXT_DUMP=/tmp/as-oneshot.json node --experimental-strip-types scripts/control-omb.ts launch
pnpm control:omb new-bot --name Probe --url http://127.0.0.1:PORT
pnpm control:omb send --bot BOT_ID --text "pull last week's sales into the sheet" --url http://127.0.0.1:PORT
pnpm control:omb wait --bot BOT_ID --timeout 60 --url http://127.0.0.1:PORT
grep auto-skill LOG_PATH   # → pending weekly-sales-report
```

Expect, in order:

1. Log `→ pending weekly-sales-report`; the thread ends with a card "Learned a
   skill from this run" (Enable / Deny) whose `skillRequest.source` is
   `learn:auto:<threadId>`. `POST /api/threads/THREAD_ID/respond` with
   `behavior: "allow"` and the card's `sha256` writes
   `<data>/workspaces/BOT_ID/skills/weekly-sales-report/SKILL.md`, enabled.
2. The same reply again logs `→ invalid (name taken)`, with no card.
3. `PATCH /api/config {"features":{"autoSkills":false}}`, then a qualifying
   turn: no `auto-skill` log line and the ledger is unchanged.
4. Full access can only be granted by the desktop app, so seed a
   `bots.json` bot with `approvalMode: "full"` before boot (as
   `server/index.test.ts` does for trusted bots). A qualifying turn logs
   `→ applied <name>`, the thread gets the receipt card "Learned a skill:
   <name>" with no buttons, and the skill is on disk and enabled.
5. The dumped prompt holds the ask, the tool names with arguments and the final
   reply between BEGIN RUN / END RUN, and no tool output.

Unit coverage: `pnpm exec vitest run server/auto-skill.test.ts server/config.test.ts src/lib/feature-flags.test.ts`
(each trigger exclusion, SKIP, collisions, both caps and the day reset, timeout,
applied vs pending, flag off).

Not covered here: a real Haiku reply (whether it skips one-offs well enough),
and the Skills settings switch rendered in the app.
