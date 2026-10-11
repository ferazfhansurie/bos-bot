// Realtime voice calls: the parts that do not need a microphone. PCM16
// conversion, the frames the phone sends, the parser for what xAI sends back,
// the truncate and backoff arithmetic, tool argument handling, and the
// `/api/voice/call` round trip.
import XCTest
@testable import CompanionCore

private final class VoiceCallStub: URLProtocol {
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?
    static var statusCode = 200
    static var responseBody = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        if let body = request.httpBody {
            Self.capturedBody = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(buffer, count: count)
            }
            stream.close()
            Self.capturedBody = data
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.statusCode, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class RealtimeVoiceTests: XCTestCase {
    func testInitialChatContextIsBoundedAndExcludesActivity() {
        var old = Message(id: "old", role: .user, kind: .text, at: 1)
        old.text = "old message"
        var recent = Message(id: "recent", role: .bot, kind: .text, at: 2)
        recent.text = String(repeating: "x", count: 40_000)
        var activity = Message(id: "tool", role: .bot, kind: .activity, at: 3)
        activity.text = "private tool output"
        let context = RealtimeVoice.chatContext([old, recent, activity])
        XCTAssertTrue(context.contains("old message"))
        XCTAssertFalse(context.contains("private tool output"))
        XCTAssertTrue(context.contains("untrusted conversation data"))
        XCTAssertLessThan(context.count, 4000)
        XCTAssertEqual(RealtimeVoice.chatContext([]), "")
    }

    private func object(_ frame: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any])
    }

    private let plan = VoiceCallPlan(
        instructions: "You are Maus.",
        greeting: .init(direction: "Say hi."),
        tools: [["type": "function", "name": "stay_silent", "parameters": ["type": "object", "properties": [:]]]],
        receiptTurn: "Keep talking."
    )

    // MARK: PCM16

    func testFloatToPCM16ClampsAndScalesAsymmetrically() {
        let data = RealtimeVoice.pcm16(from: [0, 1, -1, 2, -2, 0.5, -0.5])
        let values = stride(from: 0, to: data.count, by: 2).map { i in
            Int16(bitPattern: UInt16(data[i]) | UInt16(data[i + 1]) << 8)
        }
        XCTAssertEqual(values, [0, 32767, -32768, 32767, -32768, 16383, -16384])
    }

    func testPCM16IsLittleEndian() {
        let data = RealtimeVoice.pcm16(from: [1])
        XCTAssertEqual(Array(data), [0xFF, 0x7F])
        XCTAssertEqual(Array(RealtimeVoice.pcm16(from: [-1])), [0x00, 0x80])
    }

    func testPCM16ToFloatDividesBy32768AndDropsOddByte() {
        let data = Data([0x00, 0x80, 0xFF, 0x7F, 0x00, 0x40, 0x12])
        let floats = RealtimeVoice.floats(fromPCM16: data)
        XCTAssertEqual(floats.count, 3)
        XCTAssertEqual(floats[0], -1)
        XCTAssertEqual(floats[1], 32767 / 32768, accuracy: 1e-6)
        XCTAssertEqual(floats[2], 0.5)
    }

    func testPCM16RoundTripStaysClose() {
        let samples: [Float] = (0..<256).map { sin(Float($0) / 10) * 0.8 }
        let back = RealtimeVoice.floats(fromPCM16: RealtimeVoice.pcm16(from: samples))
        for (a, b) in zip(samples, back) { XCTAssertEqual(a, b, accuracy: 1.0 / 16000) }
    }

    func testRMS() {
        XCTAssertEqual(RealtimeVoice.rms([]), 0)
        XCTAssertEqual(RealtimeVoice.rms([0.5, -0.5, 0.5, -0.5]), 0.5, accuracy: 1e-6)
    }

    // MARK: Arithmetic

    func testTruncateMillisecondsRoundAndNeverGoNegative() {
        XCTAssertEqual(RealtimeVoice.audioEndMs(playedSeconds: 1.2344), 1234)
        XCTAssertEqual(RealtimeVoice.audioEndMs(playedSeconds: 1.2345), 1235)
        XCTAssertEqual(RealtimeVoice.audioEndMs(playedSeconds: -0.4), 0)
        XCTAssertEqual(RealtimeVoice.audioEndMs(playedSeconds: .nan), 0)
        XCTAssertEqual(RealtimeVoice.audioEndMs(playedSeconds: 0), 0)
    }

    func testReconnectBackoffStartsImmediateAndCapsAtTenSeconds() {
        XCTAssertEqual(RealtimeVoice.reconnectDelay(attempt: 0), 0)
        XCTAssertEqual(RealtimeVoice.reconnectDelay(attempt: 1), 1, accuracy: 1e-9)
        XCTAssertEqual(RealtimeVoice.reconnectDelay(attempt: 2), 1.2, accuracy: 1e-9)
        XCTAssertEqual(RealtimeVoice.reconnectDelay(attempt: 3), 1.44, accuracy: 1e-9)
        XCTAssertEqual(RealtimeVoice.reconnectDelay(attempt: 19), 10)
    }

    func testDurationFormatting() {
        XCTAssertEqual(RealtimeVoice.formatDuration(12), "0:12")
        XCTAssertEqual(RealtimeVoice.formatDuration(76, padMinutes: true), "01:16")
        XCTAssertEqual(RealtimeVoice.formatDuration(-3), "0:00")
    }

    // MARK: URL

    func testRealtimeURLAddsModelAndConversation() throws {
        let credential = VoiceCallCredential(clientSecret: "s3cret", expiresAt: 0, model: "grok-voice-3.0",
                                             websocketUrl: "wss://api.x.ai/v1/realtime")
        XCTAssertEqual(try RealtimeVoice.realtimeURL(credential: credential).absoluteString,
                       "wss://api.x.ai/v1/realtime?model=grok-voice-3.0")
        XCTAssertEqual(try RealtimeVoice.realtimeURL(credential: credential, conversationId: "conv_1").absoluteString,
                       "wss://api.x.ai/v1/realtime?model=grok-voice-3.0&conversation_id=conv_1")
        XCTAssertEqual(RealtimeVoice.subprotocols(for: credential), ["xai-client-secret.s3cret"])
    }

    func testRealtimeURLRefusesOtherHosts() {
        let credential = VoiceCallCredential(clientSecret: "s", expiresAt: 0, model: "m", websocketUrl: "wss://evil.example/v1/realtime")
        XCTAssertThrowsError(try RealtimeVoice.realtimeURL(credential: credential))
    }

    // MARK: Client frames

    func testSessionUpdateMatchesProtocol() throws {
        let frame = RealtimeVoice.sessionUpdate(plan: plan, settings: VoiceCallSettings(voice: "eve", speed: 1.25, language: "ms"), reconnect: false)
        let json = try object(frame)
        XCTAssertEqual(json["type"] as? String, "session.update")
        let session = try XCTUnwrap(json["session"] as? [String: Any])
        XCTAssertEqual(session["voice"] as? String, "eve")
        XCTAssertNil(session["keep_context"])
        XCTAssertEqual(session["instructions"] as? String, "You are Maus.")
        XCTAssertEqual((session["turn_detection"] as? [String: Any])?["type"] as? String, "server_vad")
        let audio = try XCTUnwrap(session["audio"] as? [String: Any])
        let input = try XCTUnwrap(audio["input"] as? [String: Any])
        let output = try XCTUnwrap(audio["output"] as? [String: Any])
        XCTAssertEqual((input["format"] as? [String: Any])?["type"] as? String, "audio/pcm")
        XCTAssertEqual((input["format"] as? [String: Any])?["rate"] as? Int, 24000)
        XCTAssertEqual((input["transcription"] as? [String: Any])?["model"] as? String, "grok-transcribe")
        XCTAssertEqual((input["transcription"] as? [String: Any])?["language_hint"] as? String, "ms")
        XCTAssertEqual(output["speed"] as? Double, 1.25)
        XCTAssertEqual((output["format"] as? [String: Any])?["rate"] as? Int, 24000)
        let tools = try XCTUnwrap(session["tools"] as? [[String: Any]])
        XCTAssertEqual(tools.first?["name"] as? String, "stay_silent")
        XCTAssertFalse(frame.contains("tool_choice"))
        XCTAssertTrue(frame.contains("\"rate\":24000"), "rate must be an integer on the wire")
    }

    func testSessionUpdateOmitsAutoLanguageAndAddsKeepContextOnReconnect() throws {
        let frame = RealtimeVoice.sessionUpdate(plan: plan, settings: VoiceCallSettings(), reconnect: true)
        let session = try XCTUnwrap(try object(frame)["session"] as? [String: Any])
        XCTAssertEqual(session["keep_context"] as? Bool, false)
        XCTAssertEqual(session["voice"] as? String, "liora")
        let input = try XCTUnwrap((session["audio"] as? [String: Any])?["input"] as? [String: Any])
        XCTAssertNil((input["transcription"] as? [String: Any])?["language_hint"])
        XCTAssertTrue(frame.contains("\"speed\":1"))
    }

    func testTruncateFrame() throws {
        let json = try object(RealtimeVoice.truncate(itemId: "item_1", contentIndex: 0, audioEndMs: 1234))
        XCTAssertEqual(json["type"] as? String, "conversation.item.truncate")
        XCTAssertEqual(json["item_id"] as? String, "item_1")
        XCTAssertEqual(json["content_index"] as? Int, 0)
        XCTAssertEqual(json["audio_end_ms"] as? Int, 1234)
    }

    func testFunctionCallOutputCarriesAJSONString() throws {
        let json = try object(RealtimeVoice.functionCallOutput(callId: "call_9", output: ["status": "sent"]))
        XCTAssertEqual(json["type"] as? String, "conversation.item.create")
        let item = try XCTUnwrap(json["item"] as? [String: Any])
        XCTAssertEqual(item["type"] as? String, "function_call_output")
        XCTAssertEqual(item["call_id"] as? String, "call_9")
        XCTAssertEqual(item["output"] as? String, "{\"status\":\"sent\"}")
    }

    func testResponseCreateWithAndWithoutInstructions() throws {
        XCTAssertEqual(RealtimeVoice.responseCreate(), "{\"type\":\"response.create\"}")
        let json = try object(RealtimeVoice.responseCreate(instructions: "Say hi."))
        XCTAssertEqual((json["response"] as? [String: Any])?["instructions"] as? String, "Say hi.")
    }

    func testAsyncUpdateShapeAndLimit() throws {
        let long = String(repeating: "a", count: 2500)
        let json = try object(RealtimeVoice.asyncUpdate(eventId: "call_1", text: long, timestampMs: 1700000000123))
        XCTAssertEqual(json["type"] as? String, "async_update.add")
        XCTAssertEqual(json["event_id"] as? String, "call_1")
        let update = try XCTUnwrap(json["async_update"] as? [String: Any])
        XCTAssertEqual(update["topic"] as? String, "work_landed")
        let payload = try XCTUnwrap((update["payload"] as? [[String: Any]])?.first)
        let message = try XCTUnwrap(payload["message"] as? [String: Any])
        XCTAssertEqual(message["type"] as? String, "text")
        XCTAssertEqual((message["content"] as? String)?.count, 2000)
        XCTAssertEqual(payload["timestampMs"] as? Int64, 1700000000123)
    }

    func testReplayFrames() throws {
        let user = try object(RealtimeVoice.replay(role: .user, text: "hi"))
        let item = try XCTUnwrap(user["item"] as? [String: Any])
        XCTAssertEqual(item["type"] as? String, "message")
        XCTAssertEqual(item["role"] as? String, "user")
        XCTAssertEqual((item["content"] as? [[String: Any]])?.first?["type"] as? String, "input_text")
        let assistant = try XCTUnwrap(try object(RealtimeVoice.replay(role: .assistant, text: "yo"))["item"] as? [String: Any])
        XCTAssertEqual((assistant["content"] as? [[String: Any]])?.first?["type"] as? String, "output_text")
        XCTAssertEqual((assistant["content"] as? [[String: Any]])?.first?["text"] as? String, "yo")
    }

    func testAudioAppend() throws {
        let json = try object(RealtimeVoice.audioAppend(base64: "AAA="))
        XCTAssertEqual(json["type"] as? String, "input_audio_buffer.append")
        XCTAssertEqual(json["audio"] as? String, "AAA=")
    }

    // MARK: Server events

    func testParsesSessionAndConversation() {
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"session.created","session":{}}"#), .sessionReady)
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"session.updated"}"#), .sessionReady)
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"conversation.created","conversation":{"id":"conv_7"}}"#),
                       .conversationCreated(id: "conv_7"))
    }

    func testParsesResponseLifecycle() {
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.created","response":{"id":"r1","metadata":{"trigger":"async_update"}}}"#),
                       .responseCreated(id: "r1", trigger: "async_update"))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.done","response":{"id":"r1"}}"#), .responseDone(id: "r1"))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.cancelled","response":{"id":"r2"}}"#), .responseDone(id: "r2"))
    }

    func testParsesBothAudioDeltaAliases() {
        let expected = RealtimeServerEvent.audioDelta(itemId: "i1", contentIndex: 0, base64: "AAA=")
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.output_audio.delta","item_id":"i1","content_index":0,"delta":"AAA="}"#), expected)
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.audio.delta","item_id":"i1","content_index":0,"delta":"AAA="}"#), expected)
    }

    func testParsesSpeechAndTranscripts() {
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"input_audio_buffer.speech_started","item_id":"u1"}"#), .speechStarted(itemId: "u1"))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"input_audio_buffer.speech_stopped"}"#), .speechStopped)
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"u1","transcript":"hello"}"#),
                       .userTranscript(itemId: "u1", text: "hello", replace: true, final: true))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"conversation.item.input_audio_transcription.updated","item_id":"u1","delta":"hel"}"#),
                       .userTranscript(itemId: "u1", text: "hel", replace: false, final: false))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.output_audio_transcript.delta","item_id":"a1","delta":"Hi"}"#),
                       .assistantTranscriptDelta(itemId: "a1", delta: "Hi"))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.audio_transcript.done","item_id":"a1","transcript":"Hi there"}"#),
                       .assistantTranscriptDone(itemId: "a1", transcript: "Hi there"))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"conversation.item.truncated","item_id":"a1","content_index":0,"audio_end_ms":900}"#),
                       .itemTruncated(itemId: "a1", audioEndMs: 900, transcript: nil))
    }

    func testParsesFunctionCallAndErrors() {
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"response.function_call_arguments.done","call_id":"c1","name":"send_task","arguments":"{\"request\":\"x\"}"}"#),
                       .functionCall(callId: "c1", name: "send_task", arguments: #"{"request":"x"}"#))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"error","error":{"type":"invalid_request_error","code":"missing_tool_call_results","message":"nope"}}"#),
                       .error(type: "invalid_request_error", code: "missing_tool_call_results", message: "nope"))
        XCTAssertEqual(RealtimeServerEvent.parse(#"{"type":"rate_limits.updated"}"#), .unsupported(type: "rate_limits.updated"))
        XCTAssertNil(RealtimeServerEvent.parse("not json"))
    }

    // MARK: Tools

    func testSendTaskValidation() {
        XCTAssertEqual(try RealtimeVoice.sendTaskRequest(arguments: #"{"request":"  book a table  "}"#, maxChars: 2000).get(), "book a table")
        XCTAssertEqual(RealtimeVoice.sendTaskRequest(arguments: #"{"request":"   "}"#, maxChars: 2000), .failure(.empty))
        XCTAssertEqual(RealtimeVoice.sendTaskRequest(arguments: "garbage", maxChars: 2000), .failure(.empty))
        let long = String(repeating: "x", count: 2001)
        XCTAssertEqual(RealtimeVoice.sendTaskRequest(arguments: JSONValue.object(["request": .string(long)]).jsonString(), maxChars: 2000),
                       .failure(.tooLong(count: 2001, max: 2000)))
    }

    func testRecallMapsRolesAndKeepsTheLastLines() throws {
        var messages: [Message] = []
        for index in 0..<40 {
            var message = Message(id: "m\(index)", role: index.isMultiple(of: 2) ? .user : .bot, kind: .text, at: Double(index))
            message.text = "line \(index)"
            messages.append(message)
        }
        var activity = Message(id: "act", role: .bot, kind: .activity, at: 99)
        activity.text = "ran a tool"
        messages.append(activity)
        let output = RealtimeVoice.recallOutput(messages)
        let lines = try XCTUnwrap(output["messages"]?.arrayValue)
        XCTAssertEqual(lines.count, 30)
        XCTAssertEqual(lines.first?["text"]?.stringValue, "line 10")
        XCTAssertEqual(lines.first?["from"]?.stringValue, "them")
        XCTAssertEqual(lines.last?["text"]?.stringValue, "line 39")
        XCTAssertEqual(lines.last?["from"]?.stringValue, "you")
    }

    // MARK: Settings

    func testSettingsNormalizeToOfferedOptions() {
        let options = VoiceCallOptions(voices: ["liora", "eve"], speeds: [0.75, 1, 1.25, 1.5, 2], languages: ["auto", "en"])
        let settings = VoiceCallSettings(voice: "nobody", speed: 1.3, language: "xx").normalized(for: options)
        XCTAssertEqual(settings, VoiceCallSettings(voice: "liora", speed: 1.25, language: "auto"))
    }

    // MARK: Start round trip

    func testVoiceHandoffRetainsIdentityAndOriginAcrossRetry() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceCallStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session)
        VoiceCallStub.statusCode = 200
        VoiceCallStub.responseBody = Data("{}".utf8)
        let sendId = UUID().uuidString.lowercased()
        var bodies: [Data] = []
        for _ in 0..<2 {
            _ = try await client.send(text: "my exact spoken words", toBot: "bot-1", threadId: "thread-1",
                                      origin: .voiceCall(callId: "call-1", job: "the request"), sendId: sendId)
            bodies.append(try XCTUnwrap(VoiceCallStub.capturedBody))
        }
        for data in bodies {
            let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(body["sendId"] as? String, sendId)
            XCTAssertEqual(body["text"] as? String, "my exact spoken words")
            XCTAssertEqual(body["threadId"] as? String, "thread-1")
            XCTAssertEqual((body["origin"] as? [String: String])?["callId"], "call-1")
        }
    }

    func testVoiceCallPostsBotAndDecodesThePlan() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceCallStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session)
        VoiceCallStub.statusCode = 200
        VoiceCallStub.responseBody = Data(#"""
        {"credential":{"clientSecret":"sec","expiresAt":1700000000,"model":"grok-voice-3.0","websocketUrl":"wss://api.x.ai/v1/realtime"},
         "plan":{"instructions":"Be Maus.","greeting":{"direction":"Say hi."},
                 "tools":[{"type":"function","name":"send_task","parameters":{"type":"object","properties":{"request":{"type":"string"}},"required":["request"]}}],
                 "receiptTurn":"Keep going.","maxRequestChars":2000},
         "options":{"voices":["liora","eve"],"speeds":[0.75,1,1.25,1.5,2],"languages":["auto","en","ms"]}}
        """#.utf8)
        let start = try await client.voiceCall(botId: "bot-1", language: "ms")
        let request = try XCTUnwrap(VoiceCallStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/voice/call")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer t")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(VoiceCallStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["botId"] as? String, "bot-1")
        XCTAssertEqual(body["language"] as? String, "ms")
        XCTAssertEqual(start.credential.clientSecret, "sec")
        XCTAssertEqual(start.plan.receiptTurn, "Keep going.")
        XCTAssertEqual(start.options.voices, ["liora", "eve"])
        // Tools survive a decode/encode round trip unchanged.
        let tool = try XCTUnwrap(start.plan.tools.first)
        XCTAssertEqual(tool["parameters"]?["required"], ["request"])
        XCTAssertTrue(tool.jsonString().contains(#""name":"send_task""#))
    }

    func testVoiceSendCarriesTheCallOrigin() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceCallStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session)
        VoiceCallStub.statusCode = 200
        VoiceCallStub.responseBody = Data(#"{"ok":true}"#.utf8)
        _ = try await client.send(text: "how many bots are online", toBot: "bot-1", threadId: "t-1",
                                  origin: .voiceCall(callId: "call-1", job: "  Count the bots online. "))
        let request = try XCTUnwrap(VoiceCallStub.capturedRequest)
        XCTAssertEqual(request.url?.path, "/api/bots/bot-1/messages")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(VoiceCallStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(body["text"] as? String, "how many bots are online")
        XCTAssertEqual(body["threadId"] as? String, "t-1")
        let origin = try XCTUnwrap(body["origin"] as? [String: Any])
        XCTAssertEqual(origin["kind"] as? String, "voice_call")
        XCTAssertEqual(origin["callId"] as? String, "call-1")
        XCTAssertEqual(origin["job"] as? String, "Count the bots online.")

        _ = try await client.send(text: "typed", toBot: "bot-1")
        let plain = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(VoiceCallStub.capturedBody)) as? [String: Any])
        XCTAssertNil(plain["origin"])
    }

    func testVoiceCallSurfacesTheMissingKeyMessage() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [VoiceCallStub.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = CompanionClient(connection: Connection(name: "Test", host: "127.0.0.1", port: 8810), token: "t", session: session)
        VoiceCallStub.statusCode = 409
        VoiceCallStub.responseBody = Data(#"{"error":"Add an xAI key in Settings on the computer to turn on voice calls."}"#.utf8)
        do {
            _ = try await client.voiceCall(botId: "bot-1", language: nil)
            XCTFail("expected a 409")
        } catch let error as APIError {
            guard case let .status(code, message) = error else { return XCTFail("wrong error \(error)") }
            XCTAssertEqual(code, 409)
            XCTAssertEqual(message, "Add an xAI key in Settings on the computer to turn on voice calls.")
        }
    }
}
