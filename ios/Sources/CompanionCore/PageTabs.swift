import Foundation

/// A page a bot opened beside one of the owner's conversations (open_tab or
/// app_create). The phone lists them from `/api/page-tabs`; the html is read
/// fresh from the bot's folder each time it is opened.
public struct PageTab: Codable, Hashable, Identifiable, Sendable {
    public var path: String
    public var title: String?
    /// Set when the page declares itself a mini app: it opens as one.
    public var appId: String?
    public var openedAt: Double
    /// Last change to the file, ms. Absent when the file is gone.
    public var mtime: Double?
    public var gone: Bool?

    public var id: String { path }

    public init(path: String, title: String? = nil, appId: String? = nil, openedAt: Double, mtime: Double? = nil, gone: Bool? = nil) {
        self.path = path; self.title = title; self.appId = appId; self.openedAt = openedAt; self.mtime = mtime; self.gone = gone
    }

    /// The title the bot gave it, else the file name without its date
    /// prefix, random suffix and extension: "2026-10-28-sales-dashboard-k3f9.html"
    /// reads "sales dashboard".
    public var displayTitle: String {
        if let title = title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty { return title }
        var name = (path.split(separator: "/").last.map(String.init) ?? path)
        name = name.replacingOccurrences(of: #"\.html?$"#, with: "", options: [.regularExpression, .caseInsensitive])
        name = name.replacingOccurrences(of: #"^\d{4}-\d{2}-\d{2}-"#, with: "", options: .regularExpression)
        name = name.replacingOccurrences(of: #"-[a-z0-9]{4}$"#, with: "", options: .regularExpression)
        name = name.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return name.isEmpty ? "Page" : name
    }
}

public struct PageTabList: Codable, Sendable {
    public var pages: [PageTab]
}

public struct PageTabHTML: Codable, Sendable {
    public var path: String
    public var html: String
    public var mtime: Double
}
