# Desks

A desk is one app a bot works in (whatsapp, meta ads manager, gmail, a site
admin) shown as a tab beside the chat: a live view of the app with take over
and hand back, and cards the bot writes in openui (summaries, lists with
one-tap buttons, preview then approve). The person changes a desk by asking
("add a button that drafts a client update"); the bot edits the same card in
place. Desks persist per bot under `<data>/desks/<bot>.json` (0600), pin to
the new tab, and are only mounted for the owner's own chats (`OMB_DESKS`).
The bundled `desks` skill drives `desk_open`, `desk_card`, `desk_list` and
`desk_remove`. Card buttons send `[<desk name> desk] …` into the chat, so
anything that sends, posts, pays or deletes still goes through the bot's
normal approvals.

```sh
node --experimental-strip-types scripts/verify-desks.ts [evidence-dir]
```

Runs a disposable server, a local stand-in ads manager page on 127.0.0.1 and
a hidden native Electron window with the real primary browser and shared bot
browser; never the installed app or real data. Each turn is a real
`claude -p` (scripts/testing/blank-tab-turn.mjs with
`FAKE_CLAUDE_TURN_SKILL=desks` and only the desk tools), so the skill pick,
the tool calls, the card validation, the broadcast and the tab are real. It
spends four short turns. The turns have no browser tools, so bos says it
can't read the page yet; the numbers come from the prompt.

Checks, with a screenshot each: "open my ads manager at … as a desk" gets
the skill, saves a desk on 127.0.0.1, and bos opens the desk tab itself with
a card showing rm42; the sign-in banner's "I'm signed in" marks the desk
ready and sends "i'm signed in to …, carry on"; when the bot browser opens
the app, the desk shows a live thumbnail with "bos is working", Take over
gives "You have control" and Hand back returns it; a card button sends a
message naming the desk and gets a turn; "add a button to the spend card…"
changes the same card id and the new button draws, and it is still there
after a window reload; Pin puts the desk on the new tab and one click opens
it.

Not covered here: the whatsapp desk (it needs a linked account; the live
screen comes from `/api/whatsapp/native/screen` and take over from
`/api/whatsapp/native/hold`), and the bot reading the app itself.
