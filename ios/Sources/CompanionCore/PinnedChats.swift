import Foundation

/// Personal presentation state, scoped to the paired computer. Never changes
/// room membership, bot behavior, or another person's conversation ordering.
public struct PinnedChats: Codable, Equatable {
    public private(set) var ids: [String]
    public init(ids: [String] = []) {
        var seen = Set<String>()
        self.ids = ids.filter { id in
            (id.hasPrefix("workspace:") || id.hasPrefix("local:") || id.hasPrefix("home:") || id.hasPrefix("contact:") || id.hasPrefix("room:"))
                && id.count <= 512 && seen.insert(id).inserted
        }
    }
    /// Migrate each old main-computer list once into a device-wide, home-qualified list.
    /// Migrate every paired home before exposing editable pins. Otherwise an
    /// old secondary-home list could resurrect a pin the person just removed.
    public static func loadCombined(legacyScopes: [String], defaults: UserDefaults = .standard) -> PinnedChats {
        for scope in Set(legacyScopes).sorted() {
            _ = loadCombined(legacyScope: scope, defaults: defaults)
        }
        return load(scope: "all-computers", defaults: defaults)
    }
    public static func loadCombined(legacyScope: String, defaults: UserDefaults = .standard) -> PinnedChats {
        var combined = load(scope: "all-computers", defaults: defaults)
        let marker = "bos.pinnedChats.migrated.\(legacyScope)"
        guard !legacyScope.isEmpty, !defaults.bool(forKey: marker) else { return combined }
        for id in load(scope: legacyScope, defaults: defaults).ids {
            let key = scopedKey(id, home: legacyScope)
            if !combined.ids.contains(key) { combined.toggle(key) }
        }
        combined.save(scope: "all-computers", defaults: defaults)
        defaults.set(true, forKey: marker)
        return combined
    }
    public static func scopedKey(_ id: String, home: String) -> String {
        if id.hasPrefix("workspace:") { return id }
        if id.hasPrefix("home:") { return "workspace:" + String(id.dropFirst(5)) }
        if id.hasPrefix("local:") { return "workspace:\(home):" + String(id.dropFirst(6)) }
        return "workspace:\(home):\(id)"
    }
    /// Missing roster entries are hidden without erasing their saved pins.
    /// They return in the same position after reconnect or a roster refresh.
    public func visibleIDs(available: Set<String>) -> [String] { ids.filter { available.contains($0) } }
    public mutating func toggle(_ id: String) {
        if ids.contains(id) { ids.removeAll { $0 == id } }
        else { self = PinnedChats(ids: ids + [id]) }
    }
    public mutating func moveToFront(_ id: String) {
        guard ids.contains(id) else { return }
        ids.removeAll { $0 == id }; ids.insert(id, at: 0)
    }
    public static func load(scope: String, defaults: UserDefaults = .standard) -> PinnedChats {
        guard !scope.isEmpty,
              let data = defaults.data(forKey: "bos.pinnedChats.v1.\(scope)"),
              let saved = try? JSONDecoder().decode(PinnedChats.self, from: data) else { return PinnedChats() }
        return PinnedChats(ids: saved.ids)
    }
    public func save(scope: String, defaults: UserDefaults = .standard) {
        guard !scope.isEmpty, let data = try? JSONEncoder().encode(self) else { return }
        defaults.set(data, forKey: "bos.pinnedChats.v1.\(scope)")
    }
}
