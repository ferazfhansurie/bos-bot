import Foundation
import XCTest
@testable import CompanionCore

final class ConnectionRegistryTests: XCTestCase {
    private let first = Connection(id: "first", name: "MacBook Air", host: "air.local", port: 8810)
    private let second = Connection(id: "second", name: "MacBook Pro", host: "pro.local", port: 8810)

    func testUpsertAndSelectKeepIndependentComputers() {
        var registry = CompanionConnectionRegistry()
        registry.upsert(first)
        registry.upsert(second)

        XCTAssertEqual(registry.connections, [first, second])
        XCTAssertEqual(registry.activeConnection, second)
        XCTAssertTrue(registry.select(id: first.id))
        XCTAssertEqual(registry.activeConnection, first)
        XCTAssertFalse(registry.select(id: "missing"))
        XCTAssertEqual(registry.activeConnection, first)
    }

    func testRefreshingAConnectionDoesNotCreateADuplicate() {
        var registry = CompanionConnectionRegistry(connections: [first], activeConnectionID: first.id)
        var refreshed = first
        refreshed.name = "Office Mac"
        refreshed.host = "office.local"

        registry.upsert(refreshed, makeActive: false)

        XCTAssertEqual(registry.connections.count, 1)
        XCTAssertEqual(registry.activeConnection?.name, "Office Mac")
        XCTAssertEqual(registry.activeConnection?.host, "office.local")
    }

    func testMatchingUsesRoutesInsteadOfAComputerName() {
        let renamed = Connection(
            id: "new-pairing-id",
            name: "Renamed laptop",
            host: "air.local",
            port: 8810
        )
        let sameNameElsewhere = Connection(
            id: "other",
            name: first.name,
            host: "somewhere-else.local",
            port: 8810
        )
        let registry = CompanionConnectionRegistry(
            connections: [first, sameNameElsewhere],
            activeConnectionID: first.id
        )

        XCTAssertEqual(registry.matchingConnection(for: renamed)?.id, first.id)
        XCTAssertNil(registry.matchingConnection(for: Connection(
            name: first.name,
            host: "third.local",
            port: 8810
        )))
    }

    func testRemovingActiveComputerFallsBackToAnotherSavedComputer() {
        var registry = CompanionConnectionRegistry(
            connections: [first, second],
            activeConnectionID: second.id
        )

        XCTAssertEqual(registry.remove(id: second.id), second)
        XCTAssertEqual(registry.connections, [first])
        XCTAssertEqual(registry.activeConnection, first)
    }

    func testDecodeNormalizesDuplicatesAndMissingActiveSelection() throws {
        let data = try JSONEncoder().encode(RegistryFixture(
            connections: [first, first, second],
            activeConnectionID: "missing"
        ))
        let registry = try JSONDecoder().decode(CompanionConnectionRegistry.self, from: data)

        XCTAssertEqual(registry.connections, [first, second])
        XCTAssertEqual(registry.activeConnection, first)
    }

    func testMigrationLiftsTheLegacySingleConnection() throws {
        let restored = CompanionConnectionRegistryMigration.restore(
            registryData: nil,
            legacyConnectionData: try JSONEncoder().encode(first)
        )

        XCTAssertTrue(restored.migratedLegacyConnection)
        XCTAssertEqual(restored.registry.connections, [first])
        XCTAssertEqual(restored.registry.activeConnection, first)
    }

    func testValidRegistryWinsOverLegacyData() throws {
        let current = CompanionConnectionRegistry(
            connections: [second],
            activeConnectionID: second.id
        )
        let restored = CompanionConnectionRegistryMigration.restore(
            registryData: try JSONEncoder().encode(current),
            legacyConnectionData: try JSONEncoder().encode(first)
        )

        XCTAssertFalse(restored.migratedLegacyConnection)
        XCTAssertEqual(restored.registry, current)
    }
}

private struct RegistryFixture: Encodable {
    let connections: [Connection]
    let activeConnectionID: String?
}
