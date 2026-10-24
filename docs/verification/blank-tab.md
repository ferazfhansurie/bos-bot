# Blank tab

Any bot can make a page from plain chat ("start a new tab, make it my bosbot
dashboard"). The bundled `blank-tab` skill (on by default, picked when the
thread can show tabs) tells the bot to write one html file under
`bos-pages/` and call `open_tab`; the tab opens beside the chat, renders the
file live, reloads on edits and presents decks fullscreen. The new tab's
"Blank tab" is the empty version of the same tab: starter chips that type
into the chat, plus the library. `open_tab` is only mounted for the owner's
own chats (`OMB_PAGE_TABS`), never rooms.

```sh
node --experimental-strip-types scripts/verify-blank-tab.ts [evidence-dir]
```

Runs a disposable server and a hidden native Electron window; never the
installed app or real data. The fixture engine is the fake CLI, but each turn
is done by a real `claude -p` (scripts/testing/blank-tab-turn.mjs; override
the binary with `FAKE_CLAUDE_TURN_CLAUDE`) with that turn's own system prompt
and agents MCP server, so the skill pick, `open_tab`, the endpoint, the
broadcast and the tab are all real. That spends real model tokens: two short
runs. The chat shows "Did 0 tool calls" because the tools ran in that
sub-process, not the fake engine.

Checks, with a screenshot each: tools list starts with Blank tab and has no
New page / New video; the blank tab has no input of its own and a starter
chip fills the chat composer; with no tab open, "start a new tab and make it
a 5-slide deck about bos bot" gets the skill and the agents server, writes
one file, and bos opens the tab itself with five slides; "make slide 2 a
chart" edits the same file in place, slide 2 re-renders and no new tab
opens; Present goes fullscreen with one slide on screen, arrow and space
advance, esc exits; the library lists the deck in grid and list view and
reopens it.

## Pinning pages to the new tab

```sh
node --experimental-strip-types scripts/verify-newtab-pins.ts [evidence-dir]
```

No model: two pages are written straight into the first chat's folder. Checks
that the pin button in a page's header puts it under Tools in the next new
tab and one click opens it there; "Add a tab you made" lists this chat's
pages minus the pinned ones and pins the pick; a second chat (its own folder)
shows the same pins and opens the first chat's page; the open tab survives a
reload; unpin removes the row. Pins are per device (localStorage) and per bot.
