import XCTest
import CompanionCore
@testable import PairingPersistence

final class RecoveryTests: XCTestCase {
    func testReinstallRestoresRegistryAndExplicitForgetPersistsEmpty() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defer { defaults.removeObject(forKey: OpenMausSharedConnectionStore.registryKey) }
        let empty = CompanionConnectionRegistry()
        let saved = CompanionConnectionRegistry(connections: [Connection(id: "mac", name: "Mac", host: "mac.tail.ts.net", port: 8810)], activeConnectionID: "mac")
        let encoded = String(data: try JSONEncoder().encode(saved), encoding: .utf8)!
        var backup: String? = encoded
        try OpenMausSharedConnectionStore.recoverRegistry(sharedDefaults: nil, fallbackDefaults: defaults, readBackup: { backup })
        XCTAssertEqual(OpenMausSharedConnectionStore.loadRegistry(sharedDefaults: nil, fallbackDefaults: defaults), saved)
        OpenMausSharedConnectionStore.saveRegistry(empty, sharedDefaults: nil, fallbackDefaults: defaults, writeBackup: { backup = $0 })
        XCTAssertEqual(try JSONDecoder().decode(CompanionConnectionRegistry.self, from: Data(backup!.utf8)), empty)
        try OpenMausSharedConnectionStore.recoverRegistry(sharedDefaults: nil, fallbackDefaults: defaults, readBackup: { backup })
        XCTAssertEqual(OpenMausSharedConnectionStore.loadRegistry(sharedDefaults: nil, fallbackDefaults: defaults), empty)
    }
    func testLockedKeychainDoesNotOverwriteRecovery() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        enum Locked: Error { case locked }
        XCTAssertThrowsError(try OpenMausSharedConnectionStore.recoverRegistry(sharedDefaults: nil, fallbackDefaults: defaults, readBackup: { throw Locked.locked }))
        XCTAssertNil(defaults.data(forKey: OpenMausSharedConnectionStore.registryKey))
    }
    func testExistingRegistryWinsOverBackup() throws {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(try JSONEncoder().encode(CompanionConnectionRegistry()), forKey: OpenMausSharedConnectionStore.registryKey)
        defer { defaults.removeObject(forKey: OpenMausSharedConnectionStore.registryKey) }
        try OpenMausSharedConnectionStore.recoverRegistry(sharedDefaults: nil, fallbackDefaults: defaults, readBackup: { XCTFail("Must not replace current preferences"); return nil })
    }
}
