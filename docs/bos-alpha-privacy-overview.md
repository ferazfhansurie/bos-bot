# bos alpha: data and support

this overview describes the current local-host alpha. it is release documentation; it has not been published as a legal policy.

- conversations and attachments are stored by the mac hosting the conversation. people with access to that conversation can read its messages.
- invoking a bot sends the selected conversation context and supported attachments to the bot's configured model provider. that provider's account settings and terms apply.
- shared conversations use separate provider context. joining a chat does not grant access to the bot owner's private chats, local projects, connected apps or computer.
- paired iphones connect to their host. push notifications use apple's push service when configured. device tokens and notification settings are stored for delivery.
- connected homes exchange identity, shared bot availability and authorized conversation messages over their configured links.
- editing/removing messages changes the stored conversation. removing a member ends their future access; it cannot retract copies they already saw or exported.
- support is manual: email ferazfhansurie@gmail.com for feedback or a privacy request. the support screen does not automatically upload conversations or diagnostics.
- the bos server sends anonymous usage counts to `https://bos.aihlete.com/api/ping` on its first enabled run and at most once per rolling 24 hours afterward. the json fields are `install_id` (a random uuid v4 stored in the bos data directory, independent of account/device identity), `version`, `platform`, `arch`, `engines` (detected claude/codex cli names only), `bots`, `rooms`, `room_humans_max`, `room_bots_max`, and `event` (`first_run` or `daily`). rooms exclude direct messages; local rooms include their implicit human owner. no names, emails, messages, paths, prompts or tokens are sent. settings → general → "share anonymous usage counts" defaults on; turning it off stops future pings. `BOS_NO_PING=1` overrides that setting. paired phones use their host server's setting and do not send additional pings. requests time out after five seconds, failures are silent, and failed attempts are not retried within 24 hours. ordinary https transport also exposes the server's source ip to the receiver; it is not part of the json body.

before public release, review provider-specific telemetry, crash reporting, retention, deletion, backups and notification content against the final packaged configuration. publish the complete policy with the actual operator identity and service details.
