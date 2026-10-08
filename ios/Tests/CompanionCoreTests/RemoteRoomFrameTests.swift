// A room joined on another home streams from that home; only that room's
// frames may reach this computer's state.
import XCTest
@testable import CompanionCore

final class RemoteRoomFrameTests: XCTestCase {
    private func room(_ id: String, threadId: String, home: String?) throws -> Room {
        let homeJSON = home.map { #","home":{"id":"\#($0)","name":"Partner"}"# } ?? ""
        return try JSONDecoder().decode(Room.self, from: Data("""
        {"id":"\(id)","threadId":"\(threadId)","name":"Team Inbox","memberIds":["bot"],
         "defaultResponder":{"kind":"first"},"bulletin":"","unread":false,"createdAt":1\(homeJSON)}
        """.utf8))
    }

    private func frame(_ json: String) throws -> Frame {
        try JSONDecoder().decode(Frame.self, from: Data(json.utf8))
    }

    private let message = #"{"id":"m1","role":"user","kind":"text","text":"hi","at":1}"#

    func testMessagesInAJoinedRoomPassAndOthersDrop() throws {
        let rooms = [try room("inbox", threadId: "inbox-t", home: "partner"), try room("local", threadId: "local-t", home: nil)]
        let inRoom = try frame(#"{"kind":"message","threadId":"inbox-t","message":\#(message)}"#)
        XCTAssertNotNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: inRoom))
        let elsewhere = try frame(#"{"kind":"message","threadId":"partner-private","message":\#(message)}"#)
        XCTAssertNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: elsewhere))
        let localThread = try frame(#"{"kind":"message","threadId":"local-t","message":\#(message)}"#)
        XCTAssertNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: localThread),
                     "another home cannot write into a room this computer owns")
        XCTAssertNil(remoteRoomFrame(rooms: rooms, homeId: "other", frame: inRoom),
                     "a room is only fed by its own home")
    }

    func testRuntimeFollowsTheRoomThread() throws {
        let rooms = [try room("inbox", threadId: "inbox-t", home: "partner")]
        let live = try frame(#"{"kind":"runtime","event":{"type":"content.delta","threadId":"inbox-t","delta":"he"}}"#)
        XCTAssertNotNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: live))
        let privateTurn = try frame(#"{"kind":"runtime","event":{"type":"content.delta","threadId":"bot-t","delta":"x"}}"#)
        XCTAssertNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: privateTurn))
    }

    func testRoomFrameKeepsTheHomeAndUnknownRoomsDrop() throws {
        let rooms = [try room("inbox", threadId: "inbox-t", home: "partner")]
        let relayed = try frame(#"{"kind":"group","group":{"id":"inbox","threadId":"inbox-t","name":"Renamed","memberIds":["bot"],"defaultResponder":{"kind":"first"},"bulletin":"","unread":true,"createdAt":1}}"#)
        guard case let .room(stamped)? = remoteRoomFrame(rooms: rooms, homeId: "partner", frame: relayed) else {
            return XCTFail("expected the joined room's frame")
        }
        XCTAssertEqual(stamped.home?.id, "partner")
        XCTAssertEqual(stamped.name, "Renamed")
        let stranger = try frame(#"{"kind":"group","group":{"id":"partner-only","threadId":"p","name":"x","memberIds":[],"defaultResponder":{"kind":"first"},"bulletin":"","unread":false,"createdAt":1}}"#)
        XCTAssertNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: stranger))
        XCTAssertNil(remoteRoomFrame(rooms: rooms, homeId: "partner", frame: try frame(#"{"kind":"bot.deleted","botId":"b"}"#)))
    }

    func testOneStreamPerHome() throws {
        let rooms = [try room("a", threadId: "a-t", home: "partner"), try room("b", threadId: "b-t", home: "partner"),
                     try room("c", threadId: "c-t", home: "cad"), try room("d", threadId: "d-t", home: nil)]
        XCTAssertEqual(remoteRoomStreams(rooms: rooms), ["partner": "a", "cad": "c"])
    }
}
