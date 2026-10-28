// Accessories a bot mascot wears: one piece per slot (a hat, glasses, a
// mustache, a bow tie). The catalog is `shared/mascot-accessories.ts`, id for
// id. The wire value is read leniently, like the desktop's
// `botMascotAccessories`: an unknown slot or id drops out on its own, and a
// malformed value reads as "wears nothing" rather than failing the bot.
import Foundation

public enum MascotAccessorySlot: String, CaseIterable, Codable, Sendable {
    case head, eyes, mouth, neck

    public var title: String {
        switch self {
        case .head: return "Head"
        case .eyes: return "Eyes"
        case .mouth: return "Mouth"
        case .neck: return "Neck"
        }
    }
}

public struct MascotAccessory: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
    public let slot: MascotAccessorySlot
}

public enum MascotAccessoryCatalog {
    /// Desktop order, so the pickers list the same pieces the same way.
    public static let all: [MascotAccessory] = [
        MascotAccessory(id: "top-hat", name: "Top hat", slot: .head),
        MascotAccessory(id: "cap", name: "Cap", slot: .head),
        MascotAccessory(id: "beanie", name: "Beanie", slot: .head),
        MascotAccessory(id: "crown", name: "Crown", slot: .head),
        MascotAccessory(id: "party-hat", name: "Party hat", slot: .head),
        MascotAccessory(id: "bow", name: "Bow", slot: .head),
        MascotAccessory(id: "headphones", name: "Headphones", slot: .head),
        MascotAccessory(id: "round-glasses", name: "Round glasses", slot: .eyes),
        MascotAccessory(id: "sunglasses", name: "Sunglasses", slot: .eyes),
        MascotAccessory(id: "mustache", name: "Mustache", slot: .mouth),
        MascotAccessory(id: "bow-tie", name: "Bow tie", slot: .neck),
        MascotAccessory(id: "scarf", name: "Scarf", slot: .neck),
    ]

    public static func pieces(for slot: MascotAccessorySlot) -> [MascotAccessory] {
        all.filter { $0.slot == slot }
    }

    public static func accessory(_ id: String) -> MascotAccessory? {
        all.first { $0.id == id }
    }

    /// Whether `id` is a piece worn in `slot`.
    public static func fits(_ id: String, _ slot: MascotAccessorySlot) -> Bool {
        accessory(id)?.slot == slot
    }
}

/// What a bot wears, one catalog id per slot. Only valid pieces ever get in.
public struct MascotAccessories: Codable, Hashable, Sendable {
    public private(set) var slots: [MascotAccessorySlot: String]

    public init(_ slots: [MascotAccessorySlot: String] = [:]) {
        self.slots = slots.filter { MascotAccessoryCatalog.fits($0.value, $0.key) }
    }

    /// From a loose `slot → id` dictionary (the wire shape); unknown slots
    /// and ids drop out.
    public init(raw: [String: String]) {
        var slots: [MascotAccessorySlot: String] = [:]
        for (key, id) in raw {
            if let slot = MascotAccessorySlot(rawValue: key) { slots[slot] = id }
        }
        self.init(slots)
    }

    public subscript(slot: MascotAccessorySlot) -> String? {
        get { slots[slot] }
        set {
            if let newValue, MascotAccessoryCatalog.fits(newValue, slot) { slots[slot] = newValue }
            else { slots[slot] = nil }
        }
    }

    public var isEmpty: Bool { slots.isEmpty }

    /// The wire shape, `{"head": "top-hat", ...}`.
    public var raw: [String: String] {
        Dictionary(uniqueKeysWithValues: slots.map { ($0.key.rawValue, $0.value) })
    }

    /// `nil` when it wears nothing, so callers can skip the layer.
    public var nonEmpty: MascotAccessories? { isEmpty ? nil : self }

    private struct Key: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    /// Never throws: anything that is not an object of strings reads as bare.
    public init(from decoder: Decoder) throws {
        var raw: [String: String] = [:]
        if let container = try? decoder.container(keyedBy: Key.self) {
            for slot in MascotAccessorySlot.allCases {
                if let id = try? container.decodeIfPresent(String.self, forKey: Key(stringValue: slot.rawValue)) {
                    raw[slot.rawValue] = id
                }
            }
        }
        self.init(raw: raw)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        for slot in MascotAccessorySlot.allCases {
            if let id = slots[slot] { try container.encode(id, forKey: Key(stringValue: slot.rawValue)) }
        }
    }
}
