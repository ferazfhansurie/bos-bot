// Voice calls v3: the job journal, the noise gate, the desk, the session
// frame, the resume/memo/prewarm policies and the new routes.
import XCTest
@testable import CompanionCore

private final class V3Stub: URLProtocol {
    nonisolated(unsafe) static var requests: [(path: String, body: Data)] = []
    nonisolated(unsafe) static var statusCode = 200
    nonisolated(unsafe) static var responseBody = Data()
    nonisolated(unsafe) static var failure: URLError?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                body.append(buffer, count: count)
            }
            stream.close()
        }
        Self.requests.append((request.url?.path ?? "", body))
        if let failure = Self.failure {
            client?.urlProtocol(self, didFailWithError: failure)
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private actor Calls {
    var requests: [VoiceJobsRequest] = []
    func add(_ request: VoiceJobsRequest) { requests.append(request) }
}

private struct Offline: Error {}

final class VoiceCallV3Tests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("voice-v3-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        V3Stub.requests = []
        V3Stub.statusCode = 200
        V3Stub.responseBody = Data()
        V3Stub.failure = nil
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var journalFile: DurableFile<[VoiceJobJournal.Entry]> {
        DurableFile(url: directory.appendingPathComponent("journal.json"))
    }

    private func entry(_ id: String, call: String = "call-1", ended: Bool = false) -> VoiceJobJournal.Entry {
        VoiceJobJournal.Entry(callId: call, botId: "bot-1", job: VoiceJob(jobId: id, text: "job \(id)"), savedAt: 1, callEnded: ended)
    }

    private func client() -> (CompanionClient, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [V3Stub.self]
        let session = URLSession(configuration: configuration)
        return (CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session), session)
    }

    private var v3Plan: VoiceCallPlan {
        VoiceCallPlan(instructions: "Be Maus.", greeting: .init(direction: "hi"), tools: [], receiptTurn: "", v: 3,
                      keyterms: ["partner", "Acme", "  ", "PARTNER", String(repeating: "x", count: 51)] + (0..<150).map { "term\($0)" })
    }

    // MARK: Journal

    func testJournalPersistsAndSurvivesReload() throws {
        let journal = VoiceJobJournal(file: journalFile)
        try journal.append(entry("a"))
        try journal.append(entry("b"))
        try journal.append(entry("a")) // same job twice is one entry
        XCTAssertEqual(journal.all.map(\.job.jobId), ["a", "b"])

        // A fresh instance is what the app sees after being killed.
        let reloaded = VoiceJobJournal(file: journalFile)
        XCTAssertEqual(reloaded.all.map(\.job.jobId), ["a", "b"])
        XCTAssertEqual(reloaded.all.first?.job.text, "job a")
    }

    func testJournalRemovesOnlySentOrDuplicate() async throws {
        let journal = VoiceJobJournal(file: journalFile)
        for id in ["sent", "dup", "failed", "missing"] { try journal.append(entry(id)) }
        let outcome = await journal.flush { request in
            XCTAssertEqual(request.callId, "call-1")
            XCTAssertEqual(request.jobs.map(\.jobId), ["sent", "dup", "failed", "missing"])
            return VoiceJobsResponse(results: [
                VoiceJobResult(jobId: "sent", status: .sent, threadId: "t-1"),
                VoiceJobResult(jobId: "dup", status: .duplicate, threadId: "t-2"),
                VoiceJobResult(jobId: "failed", status: .failed, error: "no bot"),
            ])
        }
        XCTAssertEqual(outcome.landed, 2)
        XCTAssertEqual(outcome.remaining, 2)
        XCTAssertEqual(journal.all.map(\.job.jobId), ["failed", "missing"])
        XCTAssertEqual(VoiceJobJournal(file: journalFile).all.map(\.job.jobId), ["failed", "missing"])
    }

    func testJournalKeepsEverythingOnAnUncertainResult() async throws {
        let journal = VoiceJobJournal(file: journalFile)
        try journal.append(entry("a"))
        try journal.append(entry("b"))
        let outcome = await journal.flush { _ in throw APIError.transport("The request timed out.") }
        XCTAssertEqual(outcome.landed, 0)
        XCTAssertEqual(journal.all.map(\.job.jobId), ["a", "b"])
        // An answer about other jobs only is uncertain for these.
        await journal.flush { _ in VoiceJobsResponse(results: [VoiceJobResult(jobId: "zzz", status: .sent)]) }
        XCTAssertEqual(VoiceJobJournal(file: journalFile).all.count, 2)
    }

    func testJournalCountsJobsThatLandAfterTheCallEnded() async throws {
        let journal = VoiceJobJournal(file: journalFile)
        try journal.append(entry("a"))
        try journal.append(entry("b", call: "call-2"))
        journal.markCallEnded("call-1")
        let calls = Calls()
        let outcome = await journal.flush { request in
            await calls.add(request)
            return VoiceJobsResponse(results: request.jobs.map { VoiceJobResult(jobId: $0.jobId, status: .sent) })
        }
        let requests = await calls.requests
        XCTAssertEqual(requests.map(\.callId), ["call-1", "call-2"], "one request per call")
        XCTAssertEqual(outcome.landedAfterCallEnd, 1)
        XCTAssertTrue(journal.isEmpty)
    }

    func testDurableOutboxSurvivesReload() throws {
        let file = DurableFile<[VoiceMemoItem]>(url: directory.appendingPathComponent("memos.json"))
        let outbox = DurableOutbox(file: file)
        try outbox.put(VoiceMemoItem(id: "A", callId: "c", botId: "b", threadId: nil, fileName: "a.m4a", recordedAt: 1))
        try outbox.put(VoiceMemoItem(id: "A", callId: "c", botId: "b", threadId: nil, fileName: "a.m4a", recordedAt: 1, uploadedPath: "/x"))
        XCTAssertEqual(DurableOutbox(file: file).all.map(\.uploadedPath), ["/x"])
        outbox.remove("A")
        XCTAssertTrue(DurableOutbox(file: file).all.isEmpty)
    }

    // MARK: Noise gate and desk

    func testNoiseGate() {
        XCTAssertTrue(VoiceNoiseGate.isMostlyNoise("[noise] uh"))
        XCTAssertTrue(VoiceNoiseGate.isMostlyNoise(""))
        XCTAssertTrue(VoiceNoiseGate.isMostlyNoise(nil))
        XCTAssertTrue(VoiceNoiseGate.isMostlyNoise("[background noise] um, hmm"))
        XCTAssertFalse(VoiceNoiseGate.isMostlyNoise("uh tell acme the deck is ready"))
        XCTAssertEqual(VoiceNoiseGate.realWords("uh do it").count, 2)
        XCTAssertEqual(VoiceNoiseGate.realWords("[noise] remind me tomorrow").count, 3)
    }

    private func desk(_ journal: VoiceJobJournal) -> VoiceCallDesk {
        VoiceCallDesk(callId: "call-1", botId: "bot-1", botName: "maus", journal: journal, makeId: { "job-1" })
    }

    func testSendTaskOnNoiseIsUnclear() throws {
        let journal = VoiceJobJournal(file: journalFile)
        let desk = desk(journal)
        let reply = desk.sendTask(arguments: #"{"request":"Send Ali the April deck by email"}"#, lastTranscript: "[noise] uh")
        XCTAssertEqual(reply.output, ["status": "unclear", "say": "say that again?"])
        XCTAssertEqual(reply.event, .unclear)
        XCTAssertTrue(desk.jobs.isEmpty, "nothing held")
    }

    func testSendTaskOnAMumbledShortRequestIsUnclear() {
        let desk = desk(VoiceJobJournal(file: journalFile))
        let reply = desk.sendTask(arguments: #"{"request":"uh do it"}"#, lastTranscript: "mm do it")
        XCTAssertEqual(reply.output["status"], "unclear")
        XCTAssertEqual(reply.event, .unclear)
    }

    func testSendTaskOnAClearRequestReadsBack() {
        let desk = desk(VoiceJobJournal(file: journalFile))
        let clear = desk.sendTask(arguments: #"{"request":"Email Ali the April deck","readback":"email ali the april deck."}"#,
                                  lastTranscript: "can you email ali the april deck")
        XCTAssertEqual(clear.output, ["status": "read_back", "job_id": "job-1", "say": "email ali the april deck. go?"])
        XCTAssertNil(clear.event)
        XCTAssertEqual(desk.jobs.map(\.status), [.said])
        XCTAssertEqual(desk.jobs.first?.text, "Email Ali the April deck", "job text is the request only")

        let fallback = VoiceCallDesk(callId: "c", botId: "b", botName: "maus", journal: VoiceJobJournal(file: journalFile), makeId: { "j" })
            .sendTask(arguments: #"{"request":"Email Ali the April deck"}"#, lastTranscript: "email ali the april deck")
        XCTAssertEqual(fallback.output["say"], "maus: Email Ali the April deck. go?")
    }

    func testConfirmGoJournalsBeforeSavedAndCancelDrops() throws {
        let journal = VoiceJobJournal(file: journalFile)
        let desk = desk(journal)
        _ = desk.sendTask(arguments: #"{"request":"Email Ali the April deck"}"#, lastTranscript: "email ali the april deck")
        // no decision, or anything but go/cancel, saves nothing
        for unclear in [#"{"job_id":"job-1"}"#, #"{"job_id":"job-1","decision":"maybe"}"#] {
            XCTAssertEqual(desk.confirmJob(arguments: unclear).output["status"], "error")
        }
        XCTAssertFalse(journal.contains(jobId: "job-1"))
        XCTAssertEqual(desk.jobs.map(\.status), [.said])
        let saved = desk.confirmJob(arguments: #"{"job_id":"job-1","decision":"go"}"#)
        XCTAssertEqual(saved.output, ["status": "saved", "say": "saved."])
        XCTAssertTrue(saved.flush)
        XCTAssertEqual(VoiceJobJournal(file: journalFile).all.map(\.job.jobId), ["job-1"], "on disk before saved returns")
        XCTAssertEqual(desk.jobs.map(\.status), [.queued])

        let other = VoiceCallDesk(callId: "call-1", botId: "bot-1", botName: "maus", journal: journal, makeId: { "x1" })
        _ = other.sendTask(arguments: #"{"request":"Book the room for friday"}"#, lastTranscript: "book the room for friday")
        let cancelled = other.confirmJob(arguments: #"{"job_id":"x1","decision":"cancel"}"#)
        XCTAssertEqual(cancelled.output, ["status": "cancelled"])
        XCTAssertFalse(journal.contains(jobId: "x1"))
        XCTAssertEqual(other.jobs.map(\.status), [.cancelled])
    }

    /// Scripted drop mid-job: confirmed and journaled, then the socket drops
    /// (the flush fails), then the call resumes and the flush lands it.
    func testDropMidJobKeepsTheJobAndFlushesAfterResume() async throws {
        let journal = VoiceJobJournal(file: journalFile)
        let desk = desk(journal)
        _ = desk.sendTask(arguments: #"{"request":"Email Ali the April deck"}"#, lastTranscript: "email ali the april deck")
        XCTAssertTrue(desk.confirmJob(arguments: #"{"job_id":"job-1","decision":"go"}"#).flush)

        // The line drops: the confirm flush never reaches the computer.
        let dropped = await journal.flush { _ in throw Offline() }
        desk.apply(dropped.results)
        XCTAssertEqual(VoiceJobJournal(file: journalFile).all.map(\.job.jobId), ["job-1"])
        XCTAssertEqual(desk.jobs.first?.status, .queued)

        // Resume: the reconnect flush lands it.
        let resumed = await journal.flush { request in
            VoiceJobsResponse(results: request.jobs.map { VoiceJobResult(jobId: $0.jobId, status: .sent, botId: "bot-1", threadId: "t-9") })
        }
        desk.apply(resumed.results)
        XCTAssertEqual(resumed.landed, 1)
        XCTAssertTrue(VoiceJobJournal(file: journalFile).isEmpty)
        XCTAssertEqual(desk.jobs.first?.status, .sent)
        XCTAssertEqual(desk.jobs.first?.threadId, "t-9")
    }

    func testTranscriptLogKeepsEachItemOnce() {
        var log = VoiceTranscriptLog()
        log.upsert(itemId: "i1", role: .user, text: "email ali", at: 1)
        log.upsert(itemId: "i1", role: .user, text: "email ali the deck", at: 2)
        log.append(itemId: "b1", role: .bot, fragment: "on ", at: 3)
        log.append(itemId: "b1", role: .bot, fragment: "it", at: 3)
        log.upsert(itemId: "i2", role: .user, text: "", at: 4)
        XCTAssertEqual(log.transcript.map(\.text), ["email ali the deck", "on it"])
        XCTAssertEqual(log.lastCallerText, "email ali the deck")
    }

    // MARK: Session update

    func testV3SessionUpdateHasResumptionAndKeytermsAndNoKeepContext() throws {
        for reconnect in [false, true] {
            let frame = RealtimeVoice.sessionUpdate(plan: v3Plan, settings: VoiceCallSettings(), reconnect: reconnect)
            let session = try XCTUnwrap((try JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])?["session"] as? [String: Any])
            XCTAssertEqual((session["resumption"] as? [String: Any])?["enabled"] as? Bool, true)
            XCTAssertNil(session["keep_context"], "no keep_context on reconnect=\(reconnect)")
            let transcription = try XCTUnwrap(((session["audio"] as? [String: Any])?["input"] as? [String: Any])?["transcription"] as? [String: Any])
            let terms = try XCTUnwrap(transcription["keyterms"] as? [String])
            XCTAssertEqual(terms.count, 100)
            XCTAssertEqual(Array(terms.prefix(3)), ["partner", "Acme", "term0"])
            XCTAssertTrue(terms.allSatisfy { $0.count <= 50 })
        }
        // An old server's plan keeps the v2 frame.
        let v2 = VoiceCallPlan(instructions: "x", greeting: .init(direction: "hi"), tools: [], receiptTurn: "")
        let frame = RealtimeVoice.sessionUpdate(plan: v2, settings: VoiceCallSettings(), reconnect: true)
        XCTAssertTrue(frame.contains(#""keep_context":false"#))
        XCTAssertFalse(frame.contains("resumption"))
        XCTAssertFalse(frame.contains("keyterms"))
    }

    func testRealtimeURLResumesWithConversationId() throws {
        let credential = VoiceCallCredential(clientSecret: "s", expiresAt: 0, model: "m", websocketUrl: "wss://api.x.ai/v1/realtime")
        let url = try RealtimeVoice.realtimeURL(credential: credential, conversationId: "conv_1")
        XCTAssertTrue(url.absoluteString.contains("conversation_id=conv_1"))
        XCTAssertFalse(url.absoluteString.contains("keep_context"))
    }

    func testStartDecodesV3PlanFields() throws {
        let json = #"""
        {"callId":"call-7","credential":{"clientSecret":"s","expiresAt":1,"model":"m","websocketUrl":"wss://api.x.ai/v1/realtime"},
         "plan":{"instructions":"x","v":3,"keyterms":["partner"],"roster":[{"id":"b1","name":"maus"}]},
         "brief":{"text":"world","builtAt":5}}
        """#
        let start = try JSONDecoder().decode(VoiceCallStart.self, from: Data(json.utf8))
        XCTAssertTrue(start.plan.isV3)
        XCTAssertEqual(start.plan.keyterms, ["partner"])
        XCTAssertEqual(start.plan.roster, [VoiceRosterEntry(id: "b1", name: "maus")])
        XCTAssertEqual(start.brief?.text, "world")
        XCTAssertEqual(start.callId, "call-7")
        let old = try JSONDecoder().decode(VoiceCallStart.self, from: Data(
            #"{"credential":{"clientSecret":"s","expiresAt":1,"model":"m","websocketUrl":"wss://api.x.ai/"},"plan":{"instructions":"x"}}"#.utf8))
        XCTAssertFalse(old.plan.isV3)
    }

    func testSettingsDecodeMicWithDefault() throws {
        let old = try JSONDecoder().decode(VoiceCallSettings.self, from: Data(#"{"voice":"eve","speed":1.25,"language":"ms"}"#.utf8))
        XCTAssertEqual(old.mic, .phone)
        XCTAssertEqual(old.voice, "eve")
        var car = old
        car.mic = .car
        XCTAssertEqual(try JSONDecoder().decode(VoiceCallSettings.self, from: JSONEncoder().encode(car)).mic, .car)
    }

    // MARK: Wire shapes

    func testEventsEncodeFlatWithKind() throws {
        let request = VoiceCallEventRequest(callId: "c", botId: "b", event: .firstAudio(ms: 812))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any])
        let event = try XCTUnwrap(json["event"] as? [String: Any])
        XCTAssertEqual(event["kind"] as? String, "first_audio")
        XCTAssertEqual(event["ms"] as? Int, 812)
        let rating = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(VoiceCallEvent.rating(good: false))) as? [String: Any])
        XCTAssertEqual(rating["kind"] as? String, "rating")
        XCTAssertEqual(rating["good"] as? Bool, false)
        XCTAssertEqual(try JSONDecoder().decode(VoiceCallEvent.self, from: JSONEncoder().encode(VoiceCallEvent.resume(ms: 40))), .resume(ms: 40))
    }

    func testMessageDecodesTheVoiceChatCardAndSurvivesABadOne() throws {
        let good = #"""
        {"id":"m1","role":"bot","kind":"text","at":1,"text":"voice chat",
         "voiceCall":{"callId":"c","botId":"b","startedAt":1,"seconds":75,"transcript":[{"role":"user","text":"hi"}],
                      "jobs":[{"jobId":"j","text":"email ali","threadId":"t","status":"sent"}],"summary":"one job","drops":1,"resumes":1,"rating":"good"}}
        """#
        let message = try JSONDecoder().decode(Message.self, from: Data(good.utf8))
        XCTAssertEqual(message.voiceCall?.seconds, 75)
        XCTAssertEqual(message.voiceCall?.jobs.first?.threadId, "t")
        XCTAssertEqual(message.voiceCall?.rating, .good)
        let bad = try JSONDecoder().decode(Message.self, from: Data(
            #"{"id":"m2","role":"bot","kind":"text","at":1,"text":"x","voiceCall":"nope"}"#.utf8))
        XCTAssertEqual(bad.voiceCall?.isDrawable ?? false, false)
    }

    // MARK: Policies

    func testNoNetworkRecordsAMemoAnd409DoesNot() async throws {
        let (client, session) = client()
        defer { session.invalidateAndCancel() }
        V3Stub.failure = URLError(.notConnectedToInternet)
        do {
            _ = try await client.voiceCall(botId: "bot-1", language: nil)
            XCTFail("expected a failure")
        } catch {
            XCTAssertTrue(VoiceMemoPolicy.shouldRecordMemo(for: error), "network error → memo: \(error)")
        }
        V3Stub.failure = nil
        V3Stub.statusCode = 409
        V3Stub.responseBody = Data(#"{"error":"Add an xAI key"}"#.utf8)
        do {
            _ = try await client.voiceCall(botId: "bot-1", language: nil)
            XCTFail("expected a 409")
        } catch {
            XCTAssertFalse(VoiceMemoPolicy.shouldRecordMemo(for: error), "409 → no memo")
        }
        for code in [401, 403, 404, 409] {
            XCTAssertFalse(VoiceMemoPolicy.shouldRecordMemo(for: APIError.status(code: code, message: nil)))
        }
        XCTAssertTrue(VoiceMemoPolicy.shouldRecordMemo(for: APIError.status(code: 503, message: nil)))
        XCTAssertTrue(VoiceMemoPolicy.shouldRecordMemo(for: URLError(.timedOut)))
        XCTAssertFalse(VoiceMemoPolicy.shouldRecordMemo(for: RealtimeVoice.URLError.undialable("wss://evil")))
        XCTAssertFalse(VoiceMemoPolicy.shouldRecordMemo(for: CancellationError()))
    }

    func testResumeGivesUpAfterFiveAttemptsOrTwentySeconds() {
        XCTAssertTrue(VoiceResumePolicy.mayTry(attempt: 1, elapsed: 0))
        XCTAssertTrue(VoiceResumePolicy.mayTry(attempt: 5, elapsed: 19))
        XCTAssertFalse(VoiceResumePolicy.mayTry(attempt: 6, elapsed: 1))
        XCTAssertFalse(VoiceResumePolicy.mayTry(attempt: 2, elapsed: 20))
        XCTAssertEqual(VoiceResumePolicy.delay(attempt: 1), 0)
    }

    func testSpareAndPrewarmFreshness() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        let start = VoiceCallStart(credential: VoiceCallCredential(clientSecret: "s", expiresAt: 1_000_600, model: "m", websocketUrl: "wss://api.x.ai/"),
                                   plan: VoiceCallPlan(instructions: "x", greeting: .init(direction: "hi"), tools: [], receiptTurn: ""))
        XCTAssertTrue(VoiceMintedStart(start: start, mintedAt: now.addingTimeInterval(-239)).isFresh(now: now))
        XCTAssertFalse(VoiceMintedStart(start: start, mintedAt: now.addingTimeInterval(-241)).isFresh(now: now))
        var expiring = start
        expiring.credential.expiresAt = 1_000_005
        XCTAssertFalse(VoiceMintedStart(start: expiring, mintedAt: now).isFresh(now: now))

        let cache = VoicePrewarmCache()
        cache.store(botId: "b", language: nil, callId: "c1", start: start, at: now)
        XCTAssertNil(cache.take(botId: "b", language: "ms", now: now), "a different language is a different call")
        cache.store(botId: "b", language: nil, callId: "c1", start: start, at: now)
        XCTAssertEqual(cache.take(botId: "b", language: nil, now: now.addingTimeInterval(100))?.callId, "c1")
        XCTAssertNil(cache.take(botId: "b", language: nil, now: now), "used once")
    }

    // MARK: Routes

    func testV3RoutesPostTheContractShapes() async throws {
        let (client, session) = client()
        defer { session.invalidateAndCancel() }
        V3Stub.responseBody = Data(#"{"results":[{"jobId":"j1","status":"sent","threadId":"t1"}]}"#.utf8)
        let jobs = try await client.sendVoiceJobs(VoiceJobsRequest(callId: "c", botId: "b", jobs: [VoiceJob(jobId: "j1", text: "email ali")]))
        XCTAssertEqual(jobs.results.first?.landed, true)
        XCTAssertEqual(V3Stub.requests.last?.path, "/api/voice/jobs")

        V3Stub.responseBody = Data(#"{"output":"two jobs running"}"#.utf8)
        let tool = try await client.voiceTool(VoiceToolRequest(callId: "c", botId: "b", name: "check_jobs", args: [:], jobIds: ["j1"]))
        XCTAssertEqual(tool.output, "two jobs running")
        let toolBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(V3Stub.requests.last?.body)) as? [String: Any])
        XCTAssertEqual(toolBody["jobIds"] as? [String], ["j1"])

        V3Stub.responseBody = Data(#"{"ok":true}"#.utf8)
        try await client.postVoiceEvent(VoiceCallEventRequest(callId: "c", botId: "b", event: .start))
        XCTAssertEqual(V3Stub.requests.last?.path, "/api/voice/call/event")

        V3Stub.responseBody = Data(#"{"threadId":"t","messageId":"m"}"#.utf8)
        let end = try await client.endVoiceCall(VoiceCallEndRequest(
            callId: "c", botId: "b", seconds: 0, startedAt: 1, transcript: [],
            jobs: [VoiceCallEndJob(jobId: "j1", text: "email ali", status: .sent, threadId: "t1")],
            metrics: VoiceCallMetrics(drops: 1, resumes: 1, firstAudioMs: 900, inputRoute: "MicrophoneBuiltIn", outputRoute: "Speaker", mic: .phone)))
        XCTAssertEqual(end.messageId, "m")
        let endBody = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(V3Stub.requests.last?.body)) as? [String: Any])
        XCTAssertEqual(endBody["seconds"] as? Int, 0)
        XCTAssertEqual((endBody["metrics"] as? [String: Any])?["mic"] as? String, "phone")

        V3Stub.responseBody = Data(#"{"credential":{"clientSecret":"s","expiresAt":1,"model":"m","websocketUrl":"wss://api.x.ai/"},"plan":{"instructions":"x","v":3}}"#.utf8)
        _ = try await client.voiceCall(botId: "b", language: nil, callId: "c", prewarm: true)
        let mint = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(V3Stub.requests.last?.body)) as? [String: Any])
        XCTAssertEqual(mint["prewarm"] as? Bool, true)
        XCTAssertEqual(mint["callId"] as? String, "c")
    }
}
