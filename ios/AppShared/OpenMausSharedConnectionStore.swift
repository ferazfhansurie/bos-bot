import CompanionCore
import Foundation

/// Where a restored registry was found. This makes the migration decision a
/// pure value operation which can be unit-tested without mutating defaults.
enum OpenMausConnectionRegistrySource: Equatable {
    case sharedRegistry
    case fallbackRegistry
    case legacyConnection
    case empty
}

struct OpenMausConnectionRegistryResolution: Equatable {
    let registry: CompanionConnectionRegistry
    let source: OpenMausConnectionRegistrySource
}

/// Non-secret pairing metadata shared with extensions.
///
/// Tokens never enter defaults; they live in `OpenMausSharedKeychain`. The
/// standard suite is dual-written as a compatibility fallback so an unsigned
/// preview or a temporary App Group entitlement mistake cannot erase the
/// non-secret connection list. Pairing tokens intentionally migrate forward
/// into the shared Keychain group; downgrading across that migration may
/// require pairing again.
enum OpenMausSharedConnectionStore {
    static let registryKey = "companion.connections.v1"
    static let legacyConnectionKey = "companion.connection"

    private static let recoveryAccount = "bos.connection-registry.v1"

    /// Reinstall loses preferences, while this device's Keychain can survive.
    /// A read failure must propagate: never replace a locked backup with empty.
    static func recoverRegistry(
        sharedDefaults: UserDefaults? = OpenMausSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard,
        readBackup: () throws -> String? = { try OpenMausSharedKeychain.token(for: recoveryAccount) }
    ) throws {
        let current = resolve(
            sharedRegistryData: sharedDefaults?.data(forKey: registryKey),
            fallbackRegistryData: fallbackDefaults.data(forKey: registryKey),
            legacyConnectionData: fallbackDefaults.data(forKey: legacyConnectionKey)
        )
        guard current.source == .empty else { return }
        guard let backup = try readBackup() else { return }
        let data = Data(backup.utf8)
        _ = try JSONDecoder().decode(CompanionConnectionRegistry.self, from: data)
        sharedDefaults?.set(data, forKey: registryKey)
        fallbackDefaults.set(data, forKey: registryKey)
    }

    static func resolve(
        sharedRegistryData: Data?,
        fallbackRegistryData: Data?,
        legacyConnectionData: Data?
    ) -> OpenMausConnectionRegistryResolution {
        let decoder = JSONDecoder()
        if let sharedRegistryData,
           let registry = try? decoder.decode(
               CompanionConnectionRegistry.self,
               from: sharedRegistryData
           ) {
            return OpenMausConnectionRegistryResolution(
                registry: registry,
                source: .sharedRegistry
            )
        }
        if let fallbackRegistryData,
           let registry = try? decoder.decode(
               CompanionConnectionRegistry.self,
               from: fallbackRegistryData
           ) {
            return OpenMausConnectionRegistryResolution(
                registry: registry,
                source: .fallbackRegistry
            )
        }
        let legacy = CompanionConnectionRegistryMigration.restore(
            registryData: nil,
            legacyConnectionData: legacyConnectionData
        )
        return OpenMausConnectionRegistryResolution(
            registry: legacy.registry,
            source: legacy.migratedLegacyConnection ? .legacyConnection : .empty
        )
    }

    /// Load the registry, preferring the app-group copy and migrating older
    /// app-only storage into it on first use.
    static func loadRegistry(
        sharedDefaults: UserDefaults? = OpenMausSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard
    ) -> CompanionConnectionRegistry {
        let resolution = resolve(
            sharedRegistryData: sharedDefaults?.data(forKey: registryKey),
            fallbackRegistryData: fallbackDefaults.data(forKey: registryKey),
            legacyConnectionData: fallbackDefaults.data(forKey: legacyConnectionKey)
        )
        if resolution.source != .sharedRegistry {
            saveRegistry(
                resolution.registry,
                sharedDefaults: sharedDefaults,
                fallbackDefaults: fallbackDefaults
            )
        }
        return resolution.registry
    }

    static func loadActiveConnection(
        sharedDefaults: UserDefaults? = OpenMausSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard
    ) -> Connection? {
        loadRegistry(
            sharedDefaults: sharedDefaults,
            fallbackDefaults: fallbackDefaults
        ).activeConnection
    }

    static func saveRegistry(
        _ registry: CompanionConnectionRegistry,
        sharedDefaults: UserDefaults? = OpenMausSharedConfiguration.sharedDefaults,
        fallbackDefaults: UserDefaults = .standard,
        writeBackup: (String) throws -> Void = { try OpenMausSharedKeychain.save($0, for: recoveryAccount) }
    ) {
        // Include an empty registry as a tombstone after explicit Forget.
        if let data = try? JSONEncoder().encode(registry), let text = String(data: data, encoding: .utf8) {
            try? writeBackup(text)
        }
        guard !registry.connections.isEmpty else {
            sharedDefaults?.removeObject(forKey: registryKey)
            fallbackDefaults.removeObject(forKey: registryKey)
            sharedDefaults?.removeObject(forKey: legacyConnectionKey)
            fallbackDefaults.removeObject(forKey: legacyConnectionKey)
            return
        }
        guard let encoded = try? JSONEncoder().encode(registry) else { return }
        sharedDefaults?.set(encoded, forKey: registryKey)
        fallbackDefaults.set(encoded, forKey: registryKey)
        // The registry is now the safe fallback too, so the obsolete
        // single-computer record can no longer resurrect a forgotten Mac.
        sharedDefaults?.removeObject(forKey: legacyConnectionKey)
        fallbackDefaults.removeObject(forKey: legacyConnectionKey)
    }
}
