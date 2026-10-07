import Foundation
import XCTest
@testable import CompanionCore

final class CloudStorageTests: XCTestCase {
    private typealias F = CloudFixture
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("cloud-storage-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let root { try? FileManager.default.removeItem(at: root) }
    }

    private func store(_ subject: String) -> CloudAccountStore {
        CloudAccountStore(root: root, account: F.account(subject))
    }

    private func outbox(for subject: String) throws -> CloudOutbox {
        var outbox = CloudOutbox(account: F.account(subject))
        _ = try outbox.enqueue(F.envelope(1, subject: subject), windowExpiresAt: F.windowExpiry, now: F.now)
        _ = try outbox.enqueue(F.envelope(2, subject: subject), windowExpiresAt: F.windowExpiry, now: F.now)
        _ = try outbox.enqueue(F.envelope(3, subject: subject, room: "r2"), windowExpiresAt: F.windowExpiry, ephemeral: true, now: F.now)
        return outbox
    }

    func testAccountsGetDifferentFolders() {
        let alice = store("alice"), bob = store("bob")
        XCTAssertNotEqual(alice.folder, bob.folder)
        XCTAssertEqual(alice.folder.deletingLastPathComponent().lastPathComponent, "cloud")
        XCTAssertEqual(alice.folder.lastPathComponent, F.account("alice").namespace)
        XCTAssertFalse(alice.folder.path.contains("alice"), "the raw subject never appears on disk")
        // Length-preserving: ("a:b","c") and ("a","b:c") stay apart.
        XCTAssertNotEqual(CloudAccountKey(service: "s", issuer: "a:b", subject: "c").namespace, CloudAccountKey(service: "s", issuer: "a", subject: "b:c").namespace)
        XCTAssertEqual(store("alice").folder, alice.folder, "stable")
    }

    func testOutboxRoundTrip() throws {
        let alice = store("alice")
        XCTAssertNil(try alice.loadOutbox())
        let outbox = try outbox(for: "alice")
        try alice.save(outbox)
        let loaded = try XCTUnwrap(alice.loadOutbox())
        XCTAssertEqual(loaded, outbox.persisted)
        XCTAssertEqual(loaded.entries.count, 2, "guest draft not written")
        XCTAssertEqual(loaded.entries.first?.envelope, F.envelope(1))
        XCTAssertEqual(loaded.entries.first?.digest, F.envelope(1).digest)
        XCTAssertEqual(loaded.entries.first?.status, .sending)
    }

    func testOutboxFromAnotherAccountThrowsWrongAccount() throws {
        let alice = store("alice"), bob = store("bob")
        try alice.save(try outbox(for: "alice"))
        try FileManager.default.createDirectory(at: bob.folder, withIntermediateDirectories: true)
        try FileManager.default.copyItem(at: alice.outboxFile, to: bob.outboxFile)
        XCTAssertThrowsError(try bob.loadOutbox()) {
            XCTAssertEqual($0 as? CloudStoreError, .wrongAccount)
        }
        XCTAssertNotNil(try alice.loadOutbox())
    }

    func testCorruptOutboxSurfacesError() throws {
        let alice = store("alice")
        try FileManager.default.createDirectory(at: alice.folder, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: alice.outboxFile)
        XCTAssertThrowsError(try alice.loadOutbox())
    }

    func testRoomRoundTripAndGuestRoomNeverWritten() throws {
        let alice = store("alice")
        var room = CloudRoomState(workspaceId: "w1", roomId: "r1", threadId: "t1", me: "alice")
        room.apply(F.snapshot(messages: [F.message("m1", sequence: 1)], watermark: 1, cursor: "c1"))
        try alice.save(room)
        let file = alice.roomFile(workspaceId: "w1", roomId: "r1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertEqual(try alice.loadRoom(workspaceId: "w1", roomId: "r1"), room)

        // Becoming a guest removes the existing copy.
        room.role = .guest
        try alice.save(room)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        XCTAssertNil(try alice.loadRoom(workspaceId: "w1", roomId: "r1"))

        // A guest room never written creates nothing at all.
        let fresh = store("bob")
        try fresh.save(CloudRoomState(workspaceId: "w1", roomId: "r2", threadId: "t1", me: "bob", role: .guest))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fresh.folder.path))
    }

    func testRoomFileForAnotherRoomThrows() throws {
        let alice = store("alice")
        try alice.save(CloudRoomState(workspaceId: "w1", roomId: "r1", threadId: "t1", me: "alice"))
        try FileManager.default.copyItem(at: alice.roomFile(workspaceId: "w1", roomId: "r1"), to: alice.roomFile(workspaceId: "w1", roomId: "r2"))
        XCTAssertThrowsError(try alice.loadRoom(workspaceId: "w1", roomId: "r2")) {
            XCTAssertEqual($0 as? CloudStoreError, .wrongAccount)
        }
    }

    func testEraseRemovesFolderOnly() throws {
        let alice = store("alice"), bob = store("bob")
        try alice.save(try outbox(for: "alice"))
        try bob.save(try outbox(for: "bob"))
        try alice.erase()
        XCTAssertFalse(FileManager.default.fileExists(atPath: alice.folder.path))
        XCTAssertNil(try alice.loadOutbox())
        XCTAssertNotNil(try bob.loadOutbox(), "another account's store is untouched")
        XCTAssertNoThrow(try alice.erase(), "erasing twice is fine")
    }

    func testFolderExcludedFromBackup() throws {
        let alice = store("alice")
        try alice.save(try outbox(for: "alice"))
        let values = try URL(fileURLWithPath: alice.folder.path, isDirectory: true).resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        let attributes = try FileManager.default.attributesOfItem(atPath: alice.folder.path)
        XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o700)
    }

    func testDiscoveryRoundTripKeepsMemberWorkspacesOnly() throws {
        let alice = store("alice")
        XCTAssertNil(try alice.loadDiscovery())
        var discovery = F.discovery(["r1", "r2"])
        discovery.workspaces.append(CloudDiscovery.Workspace(workspaceId: "w2", role: .guest, rooms: [CloudDiscovery.Room(roomId: "g1", threadId: "t1", policyRevision: CloudSequence(1))]))
        try alice.save(discovery)
        XCTAssertEqual(try alice.loadDiscovery(), F.discovery(["r1", "r2"]), "guest workspace never written")
    }

    func testWindowsRoundTripDropsGuestAndForeignWindows() throws {
        let alice = store("alice")
        XCTAssertEqual(try alice.loadWindows(), [:])
        let guest = CloudSendWindow(namespace: F.namespace("alice", workspaceId: "w2"), windowId: "window2", windowToken: "t", issuedAt: "2026-10-07T00:00:00Z", expiresAt: "2026-11-06T00:00:00Z")
        try alice.save(windows: ["w1": F.window("alice"), "w2": guest], guestWorkspaces: ["w2"])
        XCTAssertEqual(try alice.loadWindows(), ["w1": F.window("alice")])

        // A window filed under the wrong workspace, or for bob, never loads.
        try alice.save(windows: ["w9": F.window("alice"), "w1": F.window("bob")], guestWorkspaces: [])
        XCTAssertEqual(try alice.loadWindows(), [:])
    }

    func testWipeCacheKeepsOnlyTheQuarantinedOutbox() throws {
        let alice = store("alice")
        try alice.save(try outbox(for: "alice"))
        try alice.save(CloudRoomState(workspaceId: "w1", roomId: "r1", threadId: "t1", me: "alice"))
        try alice.save(F.discovery(["r1"]))
        try alice.save(windows: ["w1": F.window("alice")], guestWorkspaces: [])
        try FileManager.default.createDirectory(at: alice.attachmentsFolder, withIntermediateDirectories: true)
        try Data("bytes".utf8).write(to: alice.attachmentsFolder.appendingPathComponent("a1"))

        try alice.wipeCache()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: alice.folder.path), ["outbox.json"])
        XCTAssertNil(try alice.loadRoom(workspaceId: "w1", roomId: "r1"))
        XCTAssertNil(try alice.loadDiscovery())
        XCTAssertEqual(try alice.loadWindows(), [:])
        XCTAssertEqual(try alice.loadOutbox()?.entries.count, 2, "unresolved sends survive for reconciliation")
        XCTAssertNoThrow(try alice.wipeCache(), "wiping twice is fine")
    }

    func testWipeCacheWithNoOutboxRemovesTheFolder() throws {
        let alice = store("alice")
        try alice.save(F.discovery(["r1"]))
        try alice.wipeCache()
        XCTAssertFalse(FileManager.default.fileExists(atPath: alice.folder.path))
        XCTAssertNoThrow(try store("nobody").wipeCache())
    }

    func testOpeningOneAccountWipesEveryOtherAccountsCache() throws {
        let alice = store("alice"), bob = store("bob"), carol = store("carol")
        try alice.save(try outbox(for: "alice"))
        try alice.save(F.discovery(["r1"]))
        try bob.save(CloudRoomState(workspaceId: "w1", roomId: "r1", threadId: "t1", me: "bob"))
        try carol.save(F.discovery(["r1"]))
        try carol.save(try outbox(for: "carol"))

        try CloudAccountStore.wipeOtherAccounts(root: root, except: F.account("carol"))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: alice.folder.path), ["outbox.json"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: bob.folder.path), "nothing left to quarantine")
        XCTAssertNotNil(try carol.loadDiscovery(), "the opening account keeps its cache")
        XCTAssertEqual(try alice.loadOutbox()?.account, F.account("alice"))
    }
}
