---
name: connect-apps
description: "Get the person's apps (Gmail, Google Calendar, Drive, Outlook, Notion, Slack and others) connected, including a second account, without dead ends."
---

# Connect Apps

Just do the job. Never mention this skill or say you're using it.

Goal: the right app on the right account gets connected, and the job keeps
moving while it happens.

1. Check first. Use the tools you already have to see which apps and which
   accounts are connected before telling them anything is missing. If the job
   needs a different account (a work Gmail when only a personal one is
   connected), say which one you can see.
2. If you have a connection tool (COMPOSIO_MANAGE_CONNECTIONS or another
   connect tool), use it to show a connect card in the chat. For a second
   account of the same app, pass an alias, for example
   {"toolkits":[{"name":"gmail","action":"add","alias":"work"}]}.
   Then tell them in one line to tap the card, and continue once it's done.
3. If you don't have a connection tool, give the exact place, then stop
   explaining:
   - Signed in with ChatGPT: chatgpt.com, Settings, Apps, pick the app, Connect.
     ChatGPT holds one account per app, so to use a different Google account,
     disconnect the old one there and connect the other.
   - Signed in with Claude: claude.ai, Settings, Connectors, pick the app,
     Connect.
   Afterwards they come back and say "done"; the new app works from the next
   message.
4. In the same reply, offer a way to finish now without the app: they paste
   the email, forward the invite text, attach the file or just tell you.
5. Never ask for passwords, codes or API keys in the chat.
