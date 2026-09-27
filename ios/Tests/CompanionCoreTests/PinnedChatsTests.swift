import XCTest
@testable import CompanionCore

final class PinnedChatsTests: XCTestCase {
    func testPinUnpinAndReorderKeepStableConversationIdentity() {
        var pins = PinnedChats()
        pins.toggle("local:bot-one"); pins.toggle("contact:person-two"); pins.toggle("room:group-three")
        XCTAssertEqual(pins.ids, ["local:bot-one", "contact:person-two", "room:group-three"])
        pins.moveToFront("room:group-three")
        XCTAssertEqual(pins.ids, ["room:group-three", "local:bot-one", "contact:person-two"])
        pins.toggle("local:bot-one")
        XCTAssertEqual(pins.ids, ["room:group-three", "contact:person-two"])
        pins.moveToFront("local:missing")
        XCTAssertEqual(pins.ids.count, 2)
    }
    func testPinsSurviveReloadAndStaySeparateBetweenComputers() {
        let suite = "bos.pins.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let pins = PinnedChats(ids: ["local:bot-one", "room:group-two"])
        pins.save(scope: "computer-a", defaults: defaults)
        XCTAssertEqual(PinnedChats.load(scope: "computer-a", defaults: defaults), pins)
        XCTAssertTrue(PinnedChats.load(scope: "computer-b", defaults: defaults).ids.isEmpty)
        // A temporarily absent roster does not rewrite the durable pin selection.
        XCTAssertEqual(PinnedChats.load(scope: "computer-a", defaults: defaults).ids.count, 2)
    }
    func testLocalRoomsAndReconnectedChatsKeepTheirPinOrder() {
        let pins = PinnedChats(ids: ["local:bot-room", "contact:person", "room:shared-group"])
        XCTAssertEqual(pins.visibleIDs(available: ["local:bot-room", "room:shared-group"]), ["local:bot-room", "room:shared-group"])
        XCTAssertEqual(pins.visibleIDs(available: Set(pins.ids)), pins.ids)
        XCTAssertEqual(pins.ids.count, 3)
    }
    func testMalformedStorageAndDuplicateIDsAreSafe() {
        let suite = "bos.pins.test.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(Data("not json".utf8), forKey: "bos.pinnedChats.v1.host")
        XCTAssertTrue(PinnedChats.load(scope: "host", defaults: defaults).ids.isEmpty)
        XCTAssertEqual(PinnedChats(ids: ["room:a", "room:a", "unsupported", "contact:b"]).ids, ["room:a", "contact:b"])
        PinnedChats(ids: ["room:a"]).save(scope: "", defaults: defaults)
        XCTAssertTrue(PinnedChats.load(scope: "", defaults: defaults).ids.isEmpty)
    }
}
