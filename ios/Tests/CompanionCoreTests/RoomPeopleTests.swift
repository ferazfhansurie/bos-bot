import Foundation
import XCTest
@testable import CompanionCore

private final class RoomPeopleStub: URLProtocol {
    static var responseBody = Data()
    static var captured: [(method: String, path: String, body: Data?)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            body = data
        }
        Self.captured.append((request.httpMethod ?? "", request.url?.path ?? "", body))
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.responseBody)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class RoomPeopleTests: XCTestCase {
    private static let room = #"{"id":"g1","threadId":"t1","name":"team inbox","memberIds":["claude"],"peopleIds":["partner:person:owner","firaz:person:owner"],"people":[{"id":"partner:person:owner","name":"Partner","homeId":"partner"},{"id":"firaz:person:owner","name":"Firaz","homeId":"firaz","homeName":"Firaz's Mac"}],"defaultResponder":{"kind":"member","botId":"claude"},"bulletin":"","unread":false,"createdAt":1}"#

    private var session: URLSession!
    private var client: CompanionClient!

    override func setUp() {
        super.setUp()
        RoomPeopleStub.captured = []
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RoomPeopleStub.self]
        session = URLSession(configuration: configuration)
        client = CompanionClient(connection: Connection(name: "Mac", host: "127.0.0.1", port: 8810), token: "paired-token", session: session)
    }

    override func tearDown() {
        session.invalidateAndCancel()
        super.tearDown()
    }

    func testRoomDecodesPeopleOwnerFirst() throws {
        let room = try JSONDecoder().decode(Room.self, from: Data(Self.room.utf8))
        XCTAssertEqual(room.people?.map(\.name), ["Partner", "Firaz"])
        XCTAssertEqual(room.people?.last?.homeName, "Firaz's Mac")
        XCTAssertEqual(room.ownerPersonId, "partner:person:owner")
        XCTAssertTrue(room.hasGuests)
    }

    func testOlderRoomHasNoPeople() throws {
        let room = try JSONDecoder().decode(Room.self, from: Data(#"{"id":"g1","threadId":"t1","name":"x","memberIds":["a"],"defaultResponder":{"kind":"everyone"},"bulletin":"","unread":false,"createdAt":1}"#.utf8))
        XCTAssertNil(room.people)
        XCTAssertNil(room.ownerPersonId)
        XCTAssertFalse(room.hasGuests)
    }

    func testSenderSeparatesOtherPeopleFromYou() throws {
        func message(_ sender: String) throws -> Message {
            try JSONDecoder().decode(Message.self, from: Data(#"{"id":"m","role":"user","kind":"text","at":1,"text":"hi"\#(sender)}"#.utf8))
        }
        let firaz = try message(#","sender":{"id":"firaz:person:owner","name":"Firaz"}"#)
        XCTAssertEqual(firaz.sender?.name, "Firaz")
        XCTAssertTrue(firaz.isFromAnotherPerson(selfID: "partner:person:owner"))
        XCTAssertFalse(firaz.isFromAnotherPerson(selfID: "firaz:person:owner"))
        // Unknown self, unstamped lines and name-only stamps all stay yours.
        XCTAssertFalse(firaz.isFromAnotherPerson(selfID: nil))
        XCTAssertFalse(try message("").isFromAnotherPerson(selfID: "partner:person:owner"))
        XCTAssertFalse(try message(#","sender":{"name":"partner@x"}"#).isFromAnotherPerson(selfID: "partner:person:owner"))
        let reply = try JSONDecoder().decode(Message.self, from: Data(#"{"id":"r","role":"bot","kind":"text","at":2,"text":"yo","from":{"botId":"claude","name":"claude","color":"blue"},"sender":{"id":"partner:bot:claude","name":"claude"}}"#.utf8))
        XCTAssertFalse(reply.isFromAnotherPerson(selfID: "partner:person:owner"))
    }

    func testPeopleInviteAndGrantRoutes() async throws {
        RoomPeopleStub.responseBody = Data(#"{"group":\#(Self.room)}"#.utf8)
        _ = try await client.addRoomPerson(roomId: "g1", personId: "firaz:person:owner")
        let removed = try await client.removeRoomPerson(roomId: "g1", personId: "firaz:person:owner")
        XCTAssertEqual(removed.id, "g1")
        RoomPeopleStub.responseBody = Data(#"{"url":"https://partner.example/pair#code=abc","expiresAt":5}"#.utf8)
        let invite = try await client.createRoomInvite(roomIds: ["g1"])
        XCTAssertEqual(invite.url, "https://partner.example/pair#code=abc")
        RoomPeopleStub.responseBody = Data(#"{"roomId":"g1","botIds":["partner:bot:claude"]}"#.utf8)
        let granted = try await client.setRoomBotGrants(roomId: "g1", botIds: ["partner:bot:claude"])
        XCTAssertEqual(granted, ["partner:bot:claude"])

        let calls = RoomPeopleStub.captured
        XCTAssertEqual(calls.map(\.method), ["POST", "DELETE", "POST", "PUT"])
        XCTAssertEqual(calls.map(\.path), ["/api/groups/g1/people", "/api/groups/g1/people/firaz:person:owner", "/api/multiplayer/invites", "/api/multiplayer/rooms/g1/bot-grants"])
        let add = try JSONSerialization.jsonObject(with: XCTUnwrap(calls[0].body)) as? [String: String]
        XCTAssertEqual(add, ["personId": "firaz:person:owner"])
        let invited = try JSONSerialization.jsonObject(with: XCTUnwrap(calls[2].body)) as? [String: [String]]
        XCTAssertEqual(invited, ["roomIds": ["g1"]])
    }
}
