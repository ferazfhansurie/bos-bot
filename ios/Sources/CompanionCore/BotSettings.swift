import Foundation

public struct BotSkill: Decodable, Identifiable, Sendable {
    public var id: String { name }
    public let name: String
    public let description: String
    public let enabled: Bool
    public let editable: Bool?
    public let source: String
    public let sha256: String
    public let warnings: [String]
}
struct BotSkillsResponse: Decodable { let skills: [BotSkill] }
struct BotSkillResponse: Decodable { let skill: BotSkill }
struct BotSkillText: Decodable { let text: String }

public enum PhoneApprovalMode: String, CaseIterable, Sendable {
    case ask, edits, auto
}
