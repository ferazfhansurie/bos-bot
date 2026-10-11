# retry identity when send priority changes

The phone resets its send priority after a tap. A disconnected phone may also
return to find the bot idle, which selects normal queue priority. Neither event
proves that the earlier message was rejected. A draft must keep the same sendId
when only that delivery preference changes.

The regression saves a draft with block priority, restores it from disk, then
retries with queue priority. Text, attachments, reply and composer contents still
define message identity. An edited message continues to get a fresh identity.
The priority field stays decodable in existing saved draft metadata.

`server/mobile-retry-priority.e2e.test.ts` runs the real server in a disposable
home with its fake engine. It sends once with block priority, pretends the
response was lost, retries with queue priority and the same sendId, then checks
that there is one canonical user message. Changed text with that same sendId
is still rejected with 409. It never writes to the installed app's data.

2026-10-11: the new phone regression failed before the change because the
restored draft generated a different UUID. After the change, 28 focused Swift
tests passed (BotDraftTests, QueuedSendClientTests, WaitingThreadHydrationTests),
and the isolated real-server test passed. Existing drafts remain decodable;
server authorization and deduplication rules are unchanged.
