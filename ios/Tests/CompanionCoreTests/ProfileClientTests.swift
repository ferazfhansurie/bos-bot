import Foundation
import XCTest
@testable import CompanionCore

private final class ProfileRequestStub: URLProtocol {
    static var responseBody = Data()
    static var capturedRequest: URLRequest?
    static var capturedBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.capturedRequest = request
        Self.capturedBody = Self.readBody(from: request)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func readBody(from request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1_024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count >= 0 else { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

final class ProfileClientTests: XCTestCase {
    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        ProfileRequestStub.capturedRequest = nil
        ProfileRequestStub.capturedBody = nil
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ProfileRequestStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(
            connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810),
            token: "paired-token",
            session: session
        )
    }

    override func tearDown() {
        session.invalidateAndCancel()
        session = nil
        client = nil
        super.tearDown()
    }

    func testProfilePatchPreservesServerLimitsWithoutClientTruncation() throws {
        let name = String(repeating: "n", count: 100)
        let title = String(repeating: "t", count: 200)
        let description = String(repeating: "d", count: 4_000)
        let data = try JSONEncoder().encode(BotProfilePatch(
            name: name, title: title, description: description, voice: ""
        ))
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(body["name"] as? String, name)
        XCTAssertEqual(body["title"] as? String, title)
        XCTAssertEqual(body["description"] as? String, description)
        XCTAssertEqual(body["voice"] as? String, "", "empty explicitly selects the workspace default")
    }

    func testProfileClientSendsOnlyFieldsOwnedByTheAction() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(avatarCrop: .rounded)
        )

        _ = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["avatarCrop"])
        XCTAssertEqual(body["avatarCrop"] as? String, "rounded")
    }

    func testProfileClientEncodesAnExplicitAvatarClearAsNull() async throws {
        ProfileRequestStub.responseBody = Self.botResponse

        _ = try await client.updateProfile(
            botId: "avatar-bot",
            patch: BotProfilePatch(avatarUrl: .clear, avatarCrop: .mascot)
        )

        _ = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        let data = try XCTUnwrap(ProfileRequestStub.capturedBody)
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["avatarCrop", "avatarUrl"])
        XCTAssertTrue(body["avatarUrl"] is NSNull)
        XCTAssertEqual(body["avatarCrop"] as? String, "mascot")
    }

    func testAvatarGenerationRequestOutlivesTheServersImageTimeout() async throws {
        ProfileRequestStub.responseBody = Self.generatedAvatarResponse

        _ = try await client.generateAvatar(botId: "avatar-bot", prompt: "Friendly researcher")

        let request = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        XCTAssertGreaterThan(request.timeoutInterval, 120)
    }

    func testChannelAvatarClearIsNarrowAndAuthenticated() async throws {
        ProfileRequestStub.responseBody = Data(#"{"group":{"id":"room-a","threadId":"thread-a","name":"HQ","memberIds":["a"],"defaultResponder":{"kind":"mentions"},"bulletin":"","unread":false,"createdAt":1}}"#.utf8)
        _ = try await client.updateRoom(id: "room-a", patch: RoomSettingsPatch(avatarUrl: .clear))
        let request = try XCTUnwrap(ProfileRequestStub.capturedRequest)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/groups/room-a")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer paired-token")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(ProfileRequestStub.capturedBody)) as? [String: Any])
        XCTAssertEqual(Array(body.keys), ["avatarUrl"])
        XCTAssertTrue(body["avatarUrl"] is NSNull)
    }

    func testChannelPolicyPatchDoesNotReplaceMessagesOrResponder() throws {
        let patch = RoomSettingsPatch(memberReplyModes: ["a": "always", "b": "mentions"], notifications: "muted")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(patch)) as? [String: Any])
        XCTAssertEqual(body.keys.sorted(), ["memberReplyModes", "notifications"])
        XCTAssertEqual(body["memberReplyModes"] as? [String: String], ["a": "always", "b": "mentions"])
    }

    func testLegacyChannelPolicyFallbackAndNewFieldsDecode() throws {
        let legacy = #"{"id":"r","threadId":"t","name":"HQ","memberIds":["a","b"],"defaultResponder":{"kind":"member","botId":"a"},"bulletin":"","unread":true,"createdAt":1}"#
        let old = try JSONDecoder().decode(Room.self, from: Data(legacy.utf8))
        XCTAssertNil(old.avatarUrl)
        XCTAssertNil(old.activeBotIds)
        XCTAssertEqual(old.replyMode(for: "a"), "always")
        XCTAssertEqual(old.replyMode(for: "b"), "mentions")
        let extended = legacy.dropLast() + #", "memberReplyModes":{"a":"mentions","b":"always"},"notifications":"mentions","activeBotIds":["b"],"avatarUrl":"/api/attachments/room-photo.png"}"#
        let updated = try JSONDecoder().decode(Room.self, from: Data(extended.utf8))
        XCTAssertEqual(updated.replyMode(for: "a"), "mentions")
        XCTAssertEqual(updated.replyMode(for: "b"), "always")
        XCTAssertEqual(updated.activeBotIds, ["b"])
        XCTAssertEqual(updated.notifications, "mentions")
        XCTAssertEqual(updated.avatarUrl, "/api/attachments/room-photo.png")
    }

    func testChannelSettingsFrameRetainsTranscriptAndTaskIdentity() throws {
        let roomData = Data(#"{"id":"r","threadId":"t","name":"HQ","memberIds":["a","b"],"defaultResponder":{"kind":"everyone"},"bulletin":"","unread":true,"createdAt":1,"tasks":[{"threadId":"t","title":"Current","createdAt":1}]}"#.utf8)
        var room = try JSONDecoder().decode(Room.self, from: roomData)
        let message = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"m","at":1,"kind":"text","role":"assistant","text":"Retained reply"}"#.utf8))
        var state = CompanionState()
        state.rooms = [room]
        state.messages["t"] = [message]
        room.avatarUrl = "/api/attachments/group.png"
        room.memberReplyModes = ["a": "mentions"]
        room.notifications = "muted"
        room.memberIds = ["a"]
        state.apply(.room(room))
        XCTAssertEqual(state.messages["t"]?.map(\.id), ["m"])
        XCTAssertEqual(state.rooms.first?.tasks?.first?.threadId, "t")
        XCTAssertEqual(state.rooms.first?.memberIds, ["a"])
        XCTAssertEqual(state.rooms.first?.replyMode(for: "a"), "mentions")
    }

    func testChannelReplySendFreezesThreadAndActualReplyReference() async throws {
        ProfileRequestStub.responseBody = Data(#"{"accepted":true}"#.utf8)
        _ = try await client.send(text: "Follow up", to: .room(id: "r", threadId: "frozen-thread"), sendId: "stable-send-123456", replyToId: "original-message")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(ProfileRequestStub.capturedBody)) as? [String: String])
        XCTAssertEqual(body["threadId"], "frozen-thread")
        XCTAssertEqual(body["replyToId"], "original-message")
        XCTAssertEqual(body["sendId"], "stable-send-123456")
        XCTAssertEqual(body["text"], "Follow up")
    }

    private static let botJSON = """
    {
      "id":"avatar-bot","threadId":"avatar-thread","name":"Scout","title":"Researcher",
      "description":"Finds evidence.","notifications":true,"color":"blue",
      "avatarUrl":"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp",
      "avatarCrop":"rounded","unread":false,
      "modelSelection":{"instanceId":"local","model":"default"},"createdAt":1786742441013
    }
    """

    private static let botResponse = Data("{\"bot\":\(botJSON)}".utf8)
    private static let generatedAvatarResponse = Data(
        "{\"avatarUrl\":\"/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp\",\"bot\":\(botJSON)}".utf8
    )
}
