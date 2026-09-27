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
    public let attachments: [SharedAttachment]?
    /// "activity" marks a tool/progress line posted by a bot (usually with an
    /// empty `text`). Absent means an ordinary message.
    public let kind: String?
    public let tool: SharedTool?

    public var isActivity: Bool { kind == "activity" }
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
    public let messages: [SharedChatMessage]
    public let changes: [SharedChatMessage]?
    public let version: Int?
    public let hasMore: Bool?
}
public struct SharedMessageResponse: Codable, Sendable { public let message: SharedChatMessage }
public struct SharedConversationPreferences: Codable, Sendable {
    public let readSequence: Int
    public let notifications: String
}

public struct SharedEligibleBot: Codable, Hashable, Identifiable, Sendable {
    public let id: String
    public let name: String
    public let ownerName: String?
}
public struct SharedEligibleBotsResponse: Codable, Sendable { public let bots: [SharedEligibleBot] }
