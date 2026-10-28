// A bot asking for an app in the chat (`kind: "connector"`): the same card
// the desktop draws (src/components/ConnectorCard.tsx), with its after-connect
// actions from shared/connect-actions.ts copied here. Keep the two tables in
// step; ConnectorCardsTests pins a few rows.
import Foundation

public struct ConnectorCardData: Codable, Hashable, Sendable {
    public enum Status: String, Codable, Sendable {
        case required, authorizing, connected, failed

        public init(from decoder: any Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = Status(rawValue: raw) ?? .required
        }
    }

    public var slug: String
    public var label: String
    public var description: String?
    public var status: Status
    public var resumeKey: String?
    public var alias: String?
    /// v3: the bot's one line on why; the description already reads
    /// "<bot> needs <app> <reason>".
    public var reason: String?
    /// v3: connected once, but the sign-in expired or was revoked.
    public var reconnect: Bool?
    public var error: String?
    public var dismissed: Bool?
    public var resumed: Bool?

    public init(slug: String, label: String, description: String? = nil, status: Status = .required,
                resumeKey: String? = nil, alias: String? = nil, reason: String? = nil, reconnect: Bool? = nil,
                error: String? = nil, dismissed: Bool? = nil, resumed: Bool? = nil) {
        self.slug = slug
        self.label = label
        self.description = description
        self.status = status
        self.resumeKey = resumeKey
        self.alias = alias
        self.reason = reason
        self.reconnect = reconnect
        self.error = error
        self.dismissed = dismissed
        self.resumed = resumed
    }

    /// The line under the app's name, as the desktop words it.
    public func detail(v3: Bool) -> String {
        switch status {
        case .authorizing: return "Waiting for sign-in…"
        case .connected:
            return resumed == true
                ? "Connected securely. Your bot is continuing the task."
                : "Connected securely. Continue the paused task when you're ready."
        case .required, .failed:
            if v3 && reconnect == true { return "\(label) needs signing in again" }
            return description?.isEmpty == false ? description! : "Connect \(label)"
        }
    }

    /// Three things to ask for once the app is connected and the task went on.
    public func afterConnectActions(v3: Bool) -> [String] {
        guard v3, status == .connected, resumed == true else { return [] }
        return ConnectActions.actions(slug: slug, label: label)
    }
}

public enum ConnectActions {
    static let table: [String: [String]] = [
        "gmail": ["summarise my unread email", "draft replies to anything urgent", "every morning, brief me on new email"],
        "googlecalendar": ["what's on my calendar today?", "find a free hour for a meeting this week", "every morning, brief me on my day"],
        "googlesheets": ["list my recent spreadsheets", "summarise the numbers in my latest sheet", "every monday, report what changed in my sheets"],
        "googledrive": ["show me what changed in my drive this week", "find my latest proposal and summarise it", "every friday, tidy up new files in my drive"],
        "slack": ["catch me up on slack", "what needs a reply from me?", "every morning, brief me on slack mentions"],
        "notion": ["summarise my recently edited notion pages", "find my open to-dos in notion", "every friday, write a weekly recap page in notion"],
        "whatsapp": ["summarise my unread whatsapp chats", "who is waiting on a reply from me?", "every evening, brief me on whatsapp"],
        "instagram": ["how did my last few posts do?", "summarise new comments and dms", "every monday, report my instagram reach"],
        "facebook": ["how is my page doing this week?", "summarise new comments on my page", "every monday, report my page reach"],
        "metaads": ["how are my ads doing this week?", "which ad is wasting the most budget?", "every morning, report yesterday's ad spend"],
    ]

    static let aliases: [String: String] = [
        "googlemail": "gmail", "gcal": "googlecalendar", "calendar": "googlecalendar",
        "sheets": "googlesheets", "drive": "googledrive", "facebookads": "metaads",
        "meta": "metaads", "instagrambusiness": "instagram",
    ]

    public static func actions(slug: String, label: String?) -> [String] {
        let key = slug.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .filter { !$0.isWhitespace && $0 != "_" && $0 != "-" }
        if let known = table[aliases[key] ?? key] { return known }
        let trimmed = (label ?? slug).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let name = trimmed.isEmpty ? "this app" : trimmed
        return [
            "what can you do with \(name) now?",
            "check \(name) for anything that needs me",
            "every morning, brief me on what's new in \(name)",
        ]
    }
}

/// `POST …/connector-cards/:id/authorize`: a sign-in page, or WhatsApp
/// linking natively on the computer (its QR is scanned from this phone, so it
/// can't be shown here).
public enum ConnectorCardAuthorization: Sendable {
    case signIn(URL)
    case native
}

struct ConnectorCardAuthorizeResponse: Decodable {
    var url: String?
    var native: Bool?
}

public struct ConnectorCardStatus: Decodable, Sendable {
    public var connected: Bool
    public var pending: Bool?
    public var status: String?
}
