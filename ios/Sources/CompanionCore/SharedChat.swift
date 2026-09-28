import Foundation

public struct SharedContact: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public let homeId: String?
    public let title: String?
    public let color: String?
    public let mascotBody: String?
    public let avatar: String?
    /// For a bot that lives on another linked Mac: whose it is.
    public let ownerName: String?
    public let remote: Bool?
}

public struct SharedRoomSummary: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let homeId: String
    public let name: String
    public let memberIds: [String]
    public let kind: String?
    public var isGroup: Bool { kind == "group" || (kind == nil && memberIds.count > 2) }
    public let createdAt: Double
    public let lastActivity: Double?
    public let preview: String?
    public let createdBy: String?
    public let revision: Int?
    public let unreadCount: Int?
    public let readSequence: Int?
    public let notifications: String?

    public func displayName(contacts: [SharedContact], selfID: String) -> String {
        let others = memberIds.filter { $0 != selfID }.compactMap { id in contacts.first { $0.id == id }?.name }
        if !isGroup, memberIds.count == 2, let peer = others.first { return peer }
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return (title.isEmpty || title == "Group chat") && !others.isEmpty ? others.joined(separator: ", ") : title.isEmpty ? "Group chat" : title
    }
}

public struct SharedActor: Codable, Hashable, Sendable {
    public let homeId: String
    public let kind: String
    public let localId: String
    public var id: String { "\(homeId):\(kind):\(localId)" }
}

public struct SharedChatMessage: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let roomId: String
    public let sequence: Int
    public let actor: SharedActor
    public let text: String
    public let at: Double
    public let sendId: String
    public let responseTo: String?
    public let replyTo: String?
    public let editedAt: Double?
    public let deletedAt: Double?
    public var reactions: [String: [String]]? = nil
    public var pinnedBy: String? = nil
    public let attachments: [SharedAttachment]?
    /// "activity" marks a tool/progress line posted by a bot (usually with an
    /// empty `text`). Absent means an ordinary message.
    public let kind: String?
    public let tool: SharedTool?

    public var isActivity: Bool { kind == "activity" }

    public var replyReference: String? {
        deletedAt != nil ? nil : replyTo ?? (actor.kind == "bot" ? responseTo : nil)
    }

    public var activityLabel: String? {
        if let tool, ["working", "still working"].contains(tool.name), let ok = tool.ok {
            if ok { return "Completed" }
            if let spoken = tool.spoken, spoken.range(of: "is (still )?working on this$", options: .regularExpression) == nil { return spoken }
            return "Stopped"
        }
        return [tool?.spoken, text, tool?.name].compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.first { !$0.isEmpty }
    }

    private var activityKey: String? {
        guard actor.kind == "bot", isActivity, sendId.hasPrefix("activity-") else { return nil }
        let receipt = sendId.replacingOccurrences(of: "-(start|ok|failed)$", with: "", options: .regularExpression)
        return "\(actor.id):\(responseTo ?? ""):\(receipt)"
    }

    /// The settled update supersedes the start row without collapsing work
    /// from another bot or another person's request.
    public static func visible(_ messages: [SharedChatMessage]) -> [SharedChatMessage] {
        var latest: [String: Int] = [:]
        for (index, message) in messages.enumerated() {
            if let key = message.activityKey { latest[key] = index }
        }
        return messages.enumerated().compactMap { index, message in
            guard let key = message.activityKey else { return message }
            return latest[key] == index ? message : nil
        }
    }
}

/// The tool behind a shared-room activity line.
public struct SharedTool: Codable, Hashable, Sendable {
    public let name: String
    public let ok: Bool?
    /// A short human phrasing of what the tool did, when the server has one.
    public let spoken: String?
}

public struct SharedAttachment: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let mime: String
    public let size: Int
}

public struct SharedFile: Codable, Hashable, Identifiable, Sendable {
    public let attachment: SharedAttachment
    public let messageId: String
    public let sequence: Int
    public let actor: SharedActor
    public let at: Double
    public var id: String { "\(messageId):\(attachment.id)" }
}
public struct SharedFilesResponse: Codable, Sendable {
    public let files: [SharedFile]
    public let hasMore: Bool
    public let before: Int?
}

public struct SharedSearchResponse: Codable, Sendable {
    public let messages: [SharedChatMessage]
    public let hasMore: Bool
    public let before: Int?
}

public struct SharedAttachmentResponse: Codable, Sendable { public let attachment: SharedAttachment }
public struct SharedAttachmentData: Codable, Sendable {
    public let attachment: SharedAttachment
    public let data: String
}

public struct SharedMe: Codable, Sendable {
    public let actorId: String?
    public let homeId: String
    public let name: String?
}

public struct SharedContactsResponse: Codable, Sendable { public let contacts: [SharedContact] }
public struct SharedRoomsResponse: Codable, Sendable { public let rooms: [SharedRoomSummary] }
public struct SharedRoomResponse: Codable, Sendable { public let room: SharedRoomSummary }
public struct SharedMessagesResponse: Codable, Sendable {
    public var typing: [String]? = nil
    public let messages: [SharedChatMessage]
    public let changes: [SharedChatMessage]?
    public let version: Int?
    public let hasMore: Bool?
}
public struct SharedMessageResponse: Codable, Sendable { public let message: SharedChatMessage }
public struct SharedConversationPreferences: Codable, Sendable {
    public let replyMode: String?
    public let replyBotId: String?
    public let replyBotIds: [String]?
    public let readSequence: Int
    public let notifications: String
}

public struct SharedEligibleBot: Codable, Hashable, Identifiable, Sendable {
    public let color: String?
    public let mascotBody: String?
    public let id: String
    public let name: String
    public let ownerName: String?
    public let availability: String?
}
public extension SharedEligibleBot {
    var availabilityLabel: String? {
        switch availability {
        case "offline": return "Host offline"
        case "update-required": return "Update required"
        case "reconnect-required": return "Reconnect required"
        default: return nil
        }
    }
    static func matching(_ bots: [SharedEligibleBot], query: String) -> [SharedEligibleBot] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return bots.filter { term.isEmpty || $0.name.localizedCaseInsensitiveContains(term) || ($0.ownerName?.localizedCaseInsensitiveContains(term) ?? false) }
    }
}
/// Shared picker labels are disambiguated across both people and bots.
public struct SharedMentionChoice: Identifiable, Sendable {
    public let id: String
    public let name: String
    public let kind: String
    public let ownerName: String?
    public let availabilityLabel: String?
    public var label: String
    public var detail: String { kind == "person" ? "Person" : (ownerName.map { $0 + "’s bot" } ?? "Bot") }

    public static func choices(contacts: [SharedContact], memberIDs: [String], bots: [SharedEligibleBot]) -> [SharedMentionChoice] {
        let roster = contacts.filter { $0.kind == "person" && memberIDs.contains($0.id) }.map {
            SharedMentionChoice(id: $0.id, name: $0.name, kind: "person", ownerName: nil, availabilityLabel: nil, label: $0.name)
        } + bots.map {
            SharedMentionChoice(id: $0.id, name: $0.name, kind: "bot", ownerName: $0.ownerName, availabilityLabel: $0.availabilityLabel, label: $0.name)
        }
        func qualifier(_ item: SharedMentionChoice) -> String {
            item.kind == "person" ? "person" : (item.ownerName.flatMap { $0.isEmpty ? nil : $0 } ?? "bot")
        }
        return roster.map { item in
            var result = item
            let same = roster.filter { $0.name.lowercased() == item.name.lowercased() }
            if same.count > 1 {
                result.label = item.name + " · " + qualifier(item)
                if same.filter({ qualifier($0).lowercased() == qualifier(item).lowercased() }).count > 1 {
                    result.label += " · " + item.id
                }
            }
            return result
        }
    }

    public static func matching(_ choices: [SharedMentionChoice], query: String) -> [SharedMentionChoice] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return choices.filter { term.isEmpty || $0.label.localizedCaseInsensitiveContains(term) || $0.detail.localizedCaseInsensitiveContains(term) }
    }
}

public struct SharedEligibleBotsResponse: Codable, Sendable { public let bots: [SharedEligibleBot] }


public struct SharedBotRequest: Codable, Identifiable, Sendable {
    public let id: String
    public let roomId: String
    public let sourceId: String
    public let sourceSequence: Int?
    public let requesterId: String
    public let botId: String
    public let botName: String
    public let ownerId: String
    public let ownerName: String
    public let state: String
    public let createdAt: Double
    public let updatedAt: Double
    public let resultId: String?
    public let resultSequence: Int?
    public let explanation: String?
    public var isActive: Bool { ["accepted", "queued", "working", "waiting-approval"].contains(state) }
    public func canCancel(actorId: String) -> Bool { isActive && (requesterId == actorId || ownerId == actorId) }
    public var stateLabel: String {
        switch state {
        case "accepted": return "Accepted"
        case "queued": return "Queued"
        case "working": return "Working"
        case "waiting-approval": return "Waiting for owner"
        case "completed": return "Completed"
        case "failed": return "Failed"
        case "offline": return "Unavailable"
        case "cancelled": return "Stopped"
        default: return "Outcome unknown"
        }
    }
}
public struct SharedRequestsResponse: Codable, Sendable {
    public let requests: [SharedBotRequest]
    public let hasMore: Bool
    public let before: Int?
}
public struct SharedRequestResponse: Codable, Sendable { public let request: SharedBotRequest }


/// Everything that affects message identity is captured before an upload awaits.
public struct SharedSendDraft: Codable, Equatable, Sendable {
    public let text: String
    public let fileIDs: [UUID]
    public let replyTo: String?
    public init(text: String, fileIDs: [UUID], replyTo: String?) {
        self.text = text; self.fileIDs = fileIDs; self.replyTo = replyTo
    }
    public func sendID(retrying previous: SharedSendDraft?, previousID: String?) -> String {
        self == previous ? previousID ?? UUID().uuidString : UUID().uuidString
    }
}
