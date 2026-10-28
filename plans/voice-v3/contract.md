# voice calls v3: contract

spec: aios-firaz/outputs/2026-10-27-voice-memory-plan.md. types: shared/voice-call.ts.
server = cash (server/, shared/). ios = ios/ only. desktop = src/ only.

## what changes for every client

1. **plan.v === 3** turns the v3 flow on. an older server answers without `v`; keep the v2 path for it.
2. **session.update** (xai docs, docs.x.ai/docs/guides/voice/agent):
   - `resumption: { enabled: true }` on the first and every resumed session. without it `conversation_id` resumes nothing (the v2 bug: every reconnect was a fresh call).
   - reconnect = same socket url + `?conversation_id=<id from conversation.created>`; do **not** send `keep_context:false` any more.
   - `audio.input.transcription.keyterms = plan.keyterms` (≤100 terms, ≤50 chars each). this is the vocabulary hint ("partner" not "pain").
   - instructions = plan.instructions (the server folds in the world brief, roster, ear rules).
3. **tools.** the plan lists them. the client owns these and never sends them to the server:
   - `send_task {request, bot?, readback}`: noise gate, then hold a pending job and return
     `{"status":"read_back","job_id":"<id>","say":"<readback>. go?"}`.
     noise gate = request under 3 real words, or the caller's last transcript is empty / mostly `[noise]`/filler → return
     `{"status":"unclear","say":"say that again?"}`, post event `unclear`, hold nothing.
   - `confirm_job {job_id, decision: "go"|"cancel"}`: go → write the job to the on-device journal (persisted before anything is sent), then POST /api/voice/jobs; return `{"status":"saved","say":"saved."}` as soon as the journal write lands (don't wait for the network). cancel → drop it, `{"status":"cancelled"}`.
   - `recall_text_messages`, `stay_silent`, `end_the_call`: as in v2.
   - **every other tool name** in plan.tools → POST /api/voice/tool `{callId, botId, name, args, jobIds}` and feed `output` back as the function_call_output. timeout 8s → output `"couldn't reach the computer. want me to make it a job?"`.
4. **job text is the request only.** never prepend the caller's words (that was the doubled transcript). each user transcript line is kept once per item id.
5. **journal.** jobs persist on device until POST /api/voice/jobs answers `sent` or `duplicate` for that jobId. flush on: confirm, reconnect, call end, app foreground, network back. if a flush lands after the call ended, local notification "sent N jobs from your call". never drop a journal entry on an uncertain result; resending is safe (idempotent on jobId).
6. **drops resume.** socket closes without a hang-up → post event `drop`, reconnect at once with a fresh secret (keep one spare pre-minted secret during the call, re-mint when it is >240s old), same conversation_id. on success post event `resume {ms}` and send `response.create` with instructions `"the line dropped and is back. say \"back.\" then in under ten words what the caller was saying."`. give up after 5 attempts / 20s → end the call normally (journal flushes later).
7. **no network → voice memo** (ios; desktop optional). when mint or connect fails for network reasons (not 409/401/403), record audio locally (m4a), tell the caller with a tone + on-screen "recording a memo", and on hang-up queue it. when online: upload as an attachment and send it to the called bot as a normal chat message with text
   `voice memo from a call that couldn't connect. list each job in it, one per line, and ask me to confirm each one here before starting any.`
   plus post event `memo`. the server already transcribes audio attachments.
8. **prewarm.** on app open / action button / hovering the call button: POST /api/voice/call `{botId, language, callId, prewarm: true}`; keep the answer ≤240s. a prewarmed call books its start with event `start` when the socket opens. first audio ms = from the user's tap to the first audio delta played → event `first_audio {ms}`.
9. **call end.** always POST /api/voice/call/end (retry until 2xx, idempotent on callId), even for a call that never connected (seconds 0). keep POST /api/voice/call/usage too for old servers (server ignores it when end landed).
10. **voice chat card.** a chat message with `voiceCall` (VoiceCallCard) renders as: "voice chat · m:ss", one-line summary, jobs (tap → that thread), transcript collapsed, good / bad buttons → event `rating`. `voiceCall.rating` set → show the chosen one.

## server routes

- `POST /api/voice/call` body `{botId, language?, callId?, prewarm?}` → `{callId, credential, plan, options, brief}`. plan adds `v:3`, `keyterms: string[]`, `roster: {id,name}[]`. prewarm books no start.
- `POST /api/voice/call/event` VoiceCallEventRequest → `{ok:true}`.
- `POST /api/voice/jobs` VoiceJobsRequest → VoiceJobsResponse. one new thread per job on the routed bot (bot name/id from the roster, default the called bot), started with origin `{kind:"voice_call", callId, job}`.
- `POST /api/voice/tool` VoiceToolRequest → VoiceToolResponse. `check_jobs`, `recall_memory {query}`, `calendar {day?}`, `status {topic}`, `needs_me`, `answer_item {item, answer}`, `follow_up {job_id|topic, text}`. client messages, spending and prod writes are never answered by voice: answer_item refuses tool approvals and says "that one needs a tap on screen".
- `POST /api/voice/call/end` VoiceCallEndRequest → VoiceCallEndResponse. writes the voice chat card into a new "voice chat" thread on the called bot, the call summary (last 3 feed the next call's brief) and call facts into that bot's memory/voice.md.
- voice tally (`<data>/voice-usage/YYYY-MM.jsonl`) gains event rows; GET usage summary adds drops, resumes, first-audio p50/p90, unclear, memos, jobs said/sent, good/bad, rm estimate.

## ios only
- callkit for **outgoing** calls: CXStartCallAction through CXCallController, reportOutgoingCall(startedConnectingAt/connectedAt), `includesCallsInRecents`, handle = bot name. audio starts in provider(didActivate:). end/mute actions drive the engine. lock screen, carplay call screen, steering wheel and bluetooth buttons follow.
- INStartCallIntent from recents / "hey siri, call bos" → start a call to that bot.
- voice settings: "mic: phone / car", default phone. phone → `setPreferredInput(builtInMic)` after activation and on every route change. log input + output port types per call into metrics.
- echo cancellation stays on (voiceChat mode + voice processing).
