import Foundation

/// Identifiers only. Authentication stays in the existing paired connection.
public struct RequestContinuation: Equatable, Sendable {
    public let home: String
    public let botId: String
    public let threadId: String
    public let messageId: String
    public let requestId: String

    public init?(url: URL) {
        guard ["bosbot", "openmausbot"].contains(url.scheme?.lowercased() ?? ""), url.host == "request",
              url.user == nil, url.password == nil, url.port == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.count == 5, Set(items.map(\.name)) == Set(["home", "bot", "thread", "message", "request"])
        else { return nil }
        func value(_ key: String) -> String? {
            guard let raw = items.first(where: { $0.name == key })?.value,
                  !raw.isEmpty, raw.count <= 200,
                  raw.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
            return raw
        }
        guard let home = value("home"), let bot = value("bot"), let thread = value("thread"),
              let message = value("message"), let request = value("request") else { return nil }
        self.home = home; self.botId = bot; self.threadId = thread; self.messageId = message; self.requestId = request
    }
}

public struct RequestContinuationTarget: Decodable, Sendable {
    public let botId: String
    public let threadId: String
    public let messageId: String
    public let requestId: String
    public let kind: String
}
