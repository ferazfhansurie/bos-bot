import XCTest
@testable import CompanionCore

final class ReadingPositionTests: XCTestCase {
    func testRestartAndOwnershipIsolation() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let owned = ReadingPositionStore(root: root, connectionID: "mac", accountIdentity: "account-a", conversationID: "bot:one", threadID: "thread")
        let position = ReadingPosition(anchorID: "middle", newestObservedID: "last", anchorSequence: 12)
        try owned.save(position)
        XCTAssertEqual(try ReadingPositionStore(root: root, connectionID: "mac", accountIdentity: "account-a", conversationID: "bot:one", threadID: "thread").load(), position)
        XCTAssertNil(try ReadingPositionStore(root: root, connectionID: "mac", accountIdentity: "account-b", conversationID: "bot:one", threadID: "thread").load())
        XCTAssertNil(try ReadingPositionStore(root: root, connectionID: "other", accountIdentity: "account-a", conversationID: "bot:one", threadID: "thread").load())
        XCTAssertNil(try ReadingPositionStore(root: root, connectionID: "mac", accountIdentity: "account-a", conversationID: "bot:two", threadID: "thread").load())
    }
    func testOnlyRetainedAnchorsAndKnownDeviceBoundaryResolve() {
        let position = ReadingPosition(anchorID: "deleted", newestObservedID: "seen")
        XCTAssertNil(position.retainedAnchor(in: ["seen", "next"]))
        XCTAssertEqual(position.firstNewMessage(in: ["seen", "next", "last"], unread: true), "next")
        XCTAssertNil(position.firstNewMessage(in: ["next", "last"], unread: true))
        XCTAssertNil(position.firstNewMessage(in: ["seen", "next"], unread: false))
        XCTAssertNil(position.firstNewMessage(in: ["seen"], unread: true))
    }
    func testCorruptPositionIsNotSilentlyOverwritten() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = ReadingPositionStore(root: root, connectionID: "mac", accountIdentity: "a", conversationID: "chat", threadID: "t")
        try store.save(.init(anchorID: "a", newestObservedID: "b"))
        let file = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil).first)
        try Data("corrupt".utf8).write(to: file)
        XCTAssertThrowsError(try store.load())
        XCTAssertThrowsError(try store.save(.init(anchorID: "new", newestObservedID: "new")))
        XCTAssertEqual(try Data(contentsOf: file), Data("corrupt".utf8))
    }
}
