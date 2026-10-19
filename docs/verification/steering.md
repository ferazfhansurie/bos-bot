# steering and paused follow-ups

new desktop and native phone sends carry explicit `priority: steer`. while a turn runs, only that message is offered to native steering; unrelated queued work stays in place. `priority: queue` is the explicit “after this” choice. clients that omit priority retain the legacy queue contract; `block` remains a compatibility-only preemption mode.

stop persists a thread-scoped queue pause before requesting cancellation. pending words stay editable/deletable and survive process restart. resume explicitly clears that pause and drains through normal admission. a fresh message does not silently resume old paused work. refusal remains queued; uncertain delivery is recorded once without replay. providers without native steering keep the correction queued rather than cancelling work under a steer label.

isolated real-server proof (all child homes/capabilities are temporary):

```
pnpm exec vitest run server/message-priority.e2e.test.ts server/steer-e2e.test.ts server/steer-queue.test.ts server/channel-queue.test.ts server/queue-edit.test.ts src/lib/composer-priority.test.ts src/components/ComposerQueuedMessages.test.ts
```

the real-server tests exercise native Claude/Codex adapter protocols with fake model processes, message identity on retry, correction-only steering, after-this backlog preservation, and direct/room stop-resume. the queue test restores persisted paused state before checking no dispatch. this does not establish physical-phone or real-provider acceptance.
