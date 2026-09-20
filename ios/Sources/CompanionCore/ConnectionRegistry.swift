import Foundation

/// The non-secret index of computers this iPhone knows about.
///
/// Device tokens remain in Keychain, one per connection id. This value is
/// safe to keep in UserDefaults and makes changing computers an ordinary
/// selection rather than a destructive unpair-and-repair cycle.
public struct CompanionConnectionRegistry: Codable, Equatable, Sendable {
    public private(set) var connections: [Connection]
    public private(set) var activeConnectionID: String?

    public init(connections: [Connection] = [], activeConnectionID: String? = nil) {
        var seen = Set<String>()
        self.connections = connections.filter { seen.insert($0.id).inserted }
        if let activeConnectionID,
           self.connections.contains(where: { $0.id == activeConnectionID }) {
            self.activeConnectionID = activeConnectionID
        } else {
            self.activeConnectionID = self.connections.first?.id
        }
    }

    public var activeConnection: Connection? {
        guard let activeConnectionID else { return nil }
        return connections.first { $0.id == activeConnectionID }
    }

    public func connection(id: String) -> Connection? {
        connections.first { $0.id == id }
    }

    /// Recognize a computer already saved under an older pairing id. A
    /// shared advertised route is stronger evidence than a display name and
    /// lets re-pairing refresh the existing Keychain item instead of drawing
    /// a duplicate row.
    public func matchingConnection(for candidate: Connection) -> Connection? {
        let candidateRoutes = Set(candidate.orderedEndpoints.map(\.url))
        guard !candidateRoutes.isEmpty else { return nil }
        return connections.first { saved in
            !candidateRoutes.isDisjoint(with: saved.orderedEndpoints.map(\.url))
        }
    }

    /// Insert or refresh one computer and optionally make it the live one.
    public mutating func upsert(_ connection: Connection, makeActive: Bool = true) {
        if let index = connections.firstIndex(where: { $0.id == connection.id }) {
            connections[index] = connection
        } else {
            connections.append(connection)
        }
        if makeActive || activeConnectionID == nil {
            activeConnectionID = connection.id
        }
    }

    @discardableResult
    public mutating func select(id: String) -> Bool {
        guard connections.contains(where: { $0.id == id }) else { return false }
        activeConnectionID = id
        return true
    }

    /// Remove one computer. When it was active, the oldest remaining saved
    /// computer becomes active so the app never lands in a false unpaired
    /// state while another valid pairing still exists.
    @discardableResult
    public mutating func remove(id: String) -> Connection? {
        guard let index = connections.firstIndex(where: { $0.id == id }) else { return nil }
        let removed = connections.remove(at: index)
        if activeConnectionID == id {
            activeConnectionID = connections.first?.id
        }
        return removed
    }

    private enum CodingKeys: String, CodingKey {
        case connections, activeConnectionID
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.init(
            connections: try container.decode([Connection].self, forKey: .connections),
            activeConnectionID: try container.decodeIfPresent(String.self, forKey: .activeConnectionID)
        )
    }
}

public struct CompanionConnectionRegistryRestore: Equatable, Sendable {
    public let registry: CompanionConnectionRegistry
    public let migratedLegacyConnection: Bool

    public init(registry: CompanionConnectionRegistry, migratedLegacyConnection: Bool) {
        self.registry = registry
        self.migratedLegacyConnection = migratedLegacyConnection
    }
}

/// Decode the new registry or lift the previous single saved connection into
/// it. Kept pure so upgrades can be tested without touching UserDefaults.
public enum CompanionConnectionRegistryMigration {
    public static func restore(
        registryData: Data?,
        legacyConnectionData: Data?
    ) -> CompanionConnectionRegistryRestore {
        let decoder = JSONDecoder()
        if let registryData,
           let registry = try? decoder.decode(CompanionConnectionRegistry.self, from: registryData) {
            return CompanionConnectionRegistryRestore(
                registry: registry,
                migratedLegacyConnection: false
            )
        }
        if let legacyConnectionData,
           let connection = try? decoder.decode(Connection.self, from: legacyConnectionData) {
            return CompanionConnectionRegistryRestore(
                registry: CompanionConnectionRegistry(
                    connections: [connection],
                    activeConnectionID: connection.id
                ),
                migratedLegacyConnection: true
            )
        }
        return CompanionConnectionRegistryRestore(
            registry: CompanionConnectionRegistry(),
            migratedLegacyConnection: false
        )
    }
}
