import Foundation

/// Personal presentation state, scoped to the paired computer. Never changes
/// room membership, bot behavior, or another person's conversation ordering.
public struct PinnedChats: Codable, Equatable {
    public private(set) var ids: [String]
    public init(ids: [String] = []) {
        var seen = Set<String>()
        self.ids = ids.filter { id in
            (id.hasPrefix("local:") || id.hasPrefix("contact:") || id.hasPrefix("room:"))
                && id.count <= 512 && seen.insert(id).inserted
        }
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
