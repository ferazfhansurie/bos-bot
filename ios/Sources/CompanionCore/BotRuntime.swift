import Foundation

public struct BotRuntimeStatus: Decodable, Sendable {
    public let threadId: String
    public let selected: String?
    public let busy: Bool
    public let runtimeLocation: String
    public let hostRequired: Bool
    public let supportsMigration: Bool
    public let options: [BotComputerOption]
}

public struct BotComputerOption: Decodable, Sendable, Identifiable {
    public var id: String { surface }
    public let surface: String
    public let label: String
    public let available: Bool
    public let ready: Bool
    public let canStart: Bool
    public let canCreate: Bool
    public let reason: String?
}
