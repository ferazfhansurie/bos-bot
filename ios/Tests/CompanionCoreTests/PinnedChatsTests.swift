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
    func testCrossHomePinsPersistWithoutCollapsingSameBotIDs() {
        let suite = "bos.pins.cross-home.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var pins = PinnedChats(ids: ["home:mac:bot", "home:box:bot", "local:bot", "home:mac:bot"])
        pins.moveToFront("home:box:bot")
        pins.save(scope: "owner", defaults: defaults)
        let restored = PinnedChats.load(scope: "owner", defaults: defaults)
        XCTAssertEqual(restored.ids, ["home:box:bot", "home:mac:bot", "local:bot"])
        XCTAssertEqual(restored.visibleIDs(available: ["local:bot", "home:mac:bot"]), ["home:mac:bot", "local:bot"])
        XCTAssertEqual(restored.visibleIDs(available: Set(restored.ids)), restored.ids)
        XCTAssertTrue(PinnedChats.load(scope: "other-owner", defaults: defaults).ids.isEmpty)
        pins.toggle("home:mac:bot")
        XCTAssertEqual(pins.ids, ["home:box:bot", "local:bot"])
    }

    func testCombinedPinsKeepTheSameIdentityWhenMainComputerChanges() {
        let suite = "bos.pins.migration.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        PinnedChats(ids: ["local:bot", "home:box:other", "contact:person"]).save(scope: "mac", defaults: defaults)
        PinnedChats(ids: ["home:mac:bot", "local:other"]).save(scope: "box", defaults: defaults)
        let combined = PinnedChats.loadCombined(legacyScopes: ["mac", "box"], defaults: defaults)
        XCTAssertEqual(Set(combined.ids), ["workspace:mac:bot", "workspace:box:other", "workspace:mac:contact:person"])
        XCTAssertEqual(PinnedChats.scopedKey("local:bot", home: "mac"), PinnedChats.scopedKey("home:mac:bot", home: "box"))
        XCTAssertEqual(PinnedChats.loadCombined(legacyScopes: ["box", "mac"], defaults: defaults), combined)
        XCTAssertNotEqual(PinnedChats.scopedKey("local:bot", home: "box"), PinnedChats.scopedKey("local:bot", home: "mac"))
    }

    func testUnpinDoesNotResurrectFromAnotherHomesLegacyList() {
        let suite = "bos.pins.unpin-migration.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        PinnedChats(ids: ["local:bot"]).save(scope: "mac", defaults: defaults)
        PinnedChats(ids: ["home:mac:bot"]).save(scope: "box", defaults: defaults)
        var combined = PinnedChats.loadCombined(legacyScopes: ["mac", "box"], defaults: defaults)
        combined.toggle("workspace:mac:bot")
        combined.save(scope: "all-computers", defaults: defaults)
        XCTAssertTrue(PinnedChats.loadCombined(legacyScopes: ["box", "mac"], defaults: defaults).ids.isEmpty)
        XCTAssertTrue(PinnedChats.loadCombined(legacyScope: "mac", defaults: defaults).ids.isEmpty)
        XCTAssertTrue(PinnedChats.loadCombined(legacyScope: "box", defaults: defaults).ids.isEmpty)
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
