---
name: blank-tab
description: "Make a page, deck, dashboard or doc page as one html file and show it live in a tab beside the chat with open_tab. Follow-ups edit the same file; the tab reloads on its own."
---

# Blank tab

The person can ask for a page in plain chat: "start a new tab, make it my bosbot dashboard", "a 5-slide deck about our pricing", "turn this into a one-pager". You write the page as one html file and open it in a tab next to this chat. They watch it there and keep talking to you here.

When to use it: they ask for a tab, page, deck, presentation, slides, dashboard or one-pager, or say "make it a page". A quick number or table they want answered in the reply stays in chat (smart ui). A website for their business goes to the website builder. A video goes to the video tools (video_create), not a page.

Making a new page:
1. Pick the file: `bos-pages/<yyyy-mm-dd>-<short-slug>-<4 random a-z0-9>.html` inside your working folder, e.g. `bos-pages/2026-10-24-bosbot-dashboard-k3f9.html`. Create the `bos-pages` folder if it is missing.
2. Write the whole page to that file (rules below). Use real data you have from tools, files or this thread; never invent numbers. If you need data you can't get, draw the layout with clearly marked sample values and say so in one line.
3. Call `open_tab` once with that path and a short title ("bosbot dashboard"). The tab opens beside this chat, or fills the blank tab they have open.
4. Reply in one short line, e.g. "done, it's in the tab. want the numbers weekly instead?" Don't paste the file path or list the slides; the tab already shows it.

Changing it ("make slide 2 a chart", "darker", "add a revenue tile"):
- Read the same file, edit it in place and keep everything else as it is. Don't make a new file and don't call open_tab again; the tab reloads by itself when the file changes. Reply in one short line about what changed.
- Only start a new file when they ask for a different page.

Page rules:
- One self-contained html file: inline <style> and <script> only. It renders in a sandbox with no network, so no cdn, no external fonts, images or fetch. Draw charts with inline svg or canvas; images go in as data: urls.
- Give it a short <title>. Make it look designed: a clear type scale, generous spacing, one accent colour. It must read well both in a narrow side panel and fullscreen on a big monitor (use %, vw, clamp()).
- A presentation or deck: every slide is a top-level <section> directly inside <body>, each a 16:9 box (width:100%; aspect-ratio:16/9) with text sized in vw/clamp so it scales. The tab's present button shows one section per screen and arrow keys move between them.
- No emojis.
