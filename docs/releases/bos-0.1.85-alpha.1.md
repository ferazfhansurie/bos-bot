# bos public alpha candidate — 0.1.85-alpha.1

companion: ios 1.0.0 (47). this is a local development-signed candidate. public distribution has not been approved.

## what changed

- people create human group chats. mention an eligible bot with `@name`; adding a bot as a group member is unnecessary.
- ordinary chat, quoted mentions and bot replies do not start more bot turns. replies identify the bot that produced them.
- conversation details use a full desktop panel and a native iphone sheet. members, notifications and destructive actions have distinct sections.
- human messages support replies, author-only editing and removal. older history, unread state and notification preferences sync through the conversation's home.
- codex supports native image steering in private bot chats. providers without live image steering retain the complete image request in the queue and explain that it will run after the current reply.
- shared requests have separate context and restricted provider execution. a peer cannot inherit private instructions, memory, connected apps or computer access just by joining a conversation. revocation cancels queued peer work and blocks stale publication.

## first conversation

1. connect the desktop to your provider for your own bot. keep the host mac awake while it serves conversations.
2. use the existing team invitation flow to connect another person. this alpha's federation still requires the supported private network connection; it is not a public cloud messaging service.
3. create a group by choosing people. send a normal message to check human delivery.
4. type `@` and choose one of your own or linked teammates’ available bots. the bot answers in the conversation and the other members can see the reply.
5. pair your iphone from desktop settings. the phone uses the same host and conversation history.

## context and permissions

shared bot replies use the supplied conversation context and supported attachments. private bot chats retain their existing tools and permissions. shared conversation mode does not grant computer or connected-app authority. images and text files up to 64 kb are supported; other documents require screenshots, pasted text or a private bot chat. codex shared mode requires the verified macos cli 0.155.1 with file-backed authentication; claude requires 2.1.280 or newer. unsupported provider versions must fail with an actionable message; they must never silently fall back to private execution.

only a message's author can edit or remove it. group owners manage membership and deletion. leaving a group removes access until another member adds the person again. deleting a conversation affects everyone and requires confirmation.

## acceptance evidence

- isolated multi-home fixtures cover human-only membership, owned-bot targeting, unauthorized targeting, scoped peer access and old-link migration.
- regressions cover edited-message retries, removal tombstones, durable peer provenance after revocation, and remote cancellation before dispatch.
- actual renderer checks cover group details, bot invocation without membership, editing and quoted replies.
- the installed iphone preserves pairing and existing chats; native group details and member avatars were checked through iphone mirroring.
- final install evidence, build identities and pending gates are recorded in the local release manifest.

## remaining public release gates

- developer id signing and notarization for mac; clean-machine downloaded-artifact validation.
- testflight distribution and production push acceptance.
- two-mac/two-phone testing, including host sleep, mobile-network changes, background notifications and recovery.
- published setup/privacy material. alpha support and privacy contact: ferazfhansurie@gmail.com.
- unfamiliar-team pilot and an explicit public-release decision.

faeez’s and putri’s current 0.1.84 servers are reachable but lack the new shared isolation capability. update those hosts before accepting cross-mac bot conversations.

no public-ready, notification-delivery or cross-device reliability claim should be made solely from a successful build.


## revision 5 / iphone build 54 — 28 september 2026

added member reactions, shared pins and pinned-history search, expiring typing indicators,
human mentions with owner-aware bot selection, request tracking and cancellation, retained
history search, and recoverable shared attachment sends across conversation navigation.
fixed two-person groups being reused as direct messages and unseen desktop messages being
marked read while reading scrollback. group details disclose history access for new members.

this is an assisted alpha candidate. the host mac must be available. faeez's older host
requires its own update; this release does not bypass access or protocol checks. private
bot tools, credentials and instructions are not granted by mentioning a bot in a group.

remaining release gates: developer-id/notarization and testflight distribution, real
closed-app push and network transitions, independent accessibility/visual qa, and client
onboarding acceptance. unsent attachment bytes and uncertain retry state survive navigation
within a running app, but are not yet guaranteed across app termination. detailed remaining
features and acceptance are tracked in the final alpha checklist; this is not a declaration
that all requested work is complete.

support and privacy requests: ferazfhansurie@gmail.com. no public release was published.
