---
name: desks
description: "Work any app the person uses (WhatsApp, Meta Ads Manager, Gmail, a site admin) like an employee: a desk tab with a live view they can watch and take over, plus control cards you write in openui and they customise by asking."
---

# Desks

A desk is one app you work in for the person. It opens as a tab beside the
chat: the app live on top (they watch, take over, hand back), your cards
below. Cards are openui, the same language as smart ui in chat.

When to open one: they want you to use an app for them ("run my ads
manager", "watch my whatsapp", "handle my gmail"), or they ask for controls
or a live view for an app. A one-off question about an app stays in chat.

Opening:
1. `desk_list` first. Reuse a desk for the same app; never make a second one.
2. `desk_open` with a short name and the app's https url
   (https://adsmanager.facebook.com/, https://mail.google.com/). For
   WhatsApp use kind "whatsapp" and no url; it uses their linked WhatsApp.
3. A new browser desk needs their sign-in. Tell them in one line to press
   Sign in on the tab and say when they're done. Never ask for passwords or
   codes in chat. Once they're in, work the app with your browser tools, or
   your WhatsApp tools for WhatsApp.
4. Put one or two useful cards on it straight away (below).

Cards (`desk_card` with desk_id, card_id slug, title, code, data):
- `code` is the layout and buttons; `data` is the numbers and rows, read in
  code as `data.x`. Write `root = Col([...])` and use `data.*`; don't define
  `data =` in code.
- Good first cards: today's summary (Stat tiles), a list to act on (Table
  with a Button per row), and preview, approve, apply for any change (show
  exactly what will change, then a Button "apply" that asks you to do it).
- Buttons use `@ToAssistant("...")`: a tap sends you that message in this
  conversation, starting `[<desk name> desk]`. Write it as a full
  instruction ("draft a reply to Aina's last message"), not a label.
- If a card would not draw, the tool tells you why and saves nothing. Fix
  it and send again.
- Only real numbers from the app or your tools. No sample values.

Changing it:
- Refresh: send the same card_id with new `data` only. The person's layout
  and buttons stay.
- Customise ("add a button that drafts replies for unread chats", "show
  spend per campaign"): `desk_list` to read the current code, change only
  what they asked, send the full new code with the same card_id.
- "every morning" / "keep it updated": propose a routine whose instructions
  refresh that card's data with desk_card (data only), quiet when nothing
  changed.
- Remove a card with `remove: true`; a whole desk with `desk_remove`.
- Pinning is theirs: the Pin button on the tab keeps it in the new tab page.

Rules:
- A button tap is the person asking. Sending, posting, paying or deleting
  still follows your normal approvals unless the owner granted it. A card
  never sends by itself.
- When they take over WhatsApp, your sends are refused until they hand back.
  Wait; don't retry in a loop. In a browser desk, stop clicking while they
  have it.
- Reply in one short line after changing a desk ("added, it's on the
  whatsapp desk"). The tab updates by itself.
