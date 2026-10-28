// Apps on the phone: the pages bots make with app_create and the mini apps
// installed from a link, with records the computer keeps (shared/apps.ts).
//
// The page is someone else's code, so the phone treats everything it sends
// as hostile: requests are re-checked here with the same rules the desktop
// tab uses (parseBridgeRequest in src/components/canvas/app-kit.ts), and the
// app id a request acts on is always the one the phone opened, never one the
// page names.
import Foundation

// MARK: - Models

public struct InstalledAppInfo: Codable, Hashable, Sendable {
    public var manifestId: String
    public var version: String
    public var source: String
    public var author: String?
    public var description: String?
}

public struct AppSummary: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var botId: String
    public var name: String
    public var icon: String?
    public var schema: String?
    public var template: String?
    public var updatedAt: Double
    public var rev: Int
    public var collections: [String: Int]
    public var installed: InstalledAppInfo?

    public init(id: String, botId: String, name: String, icon: String? = nil, schema: String? = nil, template: String? = nil,
                updatedAt: Double = 0, rev: Int = 0, collections: [String: Int] = [:], installed: InstalledAppInfo? = nil) {
        self.id = id; self.botId = botId; self.name = name; self.icon = icon; self.schema = schema
        self.template = template; self.updatedAt = updatedAt; self.rev = rev; self.collections = collections; self.installed = installed
    }

    private enum CodingKeys: String, CodingKey { case id, botId, name, icon, schema, template, updatedAt, rev, collections, installed }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botId = try c.decode(String.self, forKey: .botId)
        name = try c.decode(String.self, forKey: .name)
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        schema = try c.decodeIfPresent(String.self, forKey: .schema)
        template = try c.decodeIfPresent(String.self, forKey: .template)
        updatedAt = (try? c.decodeIfPresent(Double.self, forKey: .updatedAt)) ?? 0
        rev = (try? c.decodeIfPresent(Int.self, forKey: .rev)) ?? 0
        collections = (try? c.decodeIfPresent([String: Int].self, forKey: .collections)) ?? [:]
        installed = try? c.decodeIfPresent(InstalledAppInfo.self, forKey: .installed)
    }

    public var recordCount: Int { collections.values.reduce(0, +) }
}

struct AppList: Decodable { var apps: [Lossy<AppSummary>] }
struct AppRecords: Decodable { var records: [JSONValue] }
struct AppOneRecord: Decodable { var record: JSONValue? }
struct AppWriteBody: Encodable { var ops: [[String: JSONValue]] }

public struct AppPage: Codable, Hashable, Sendable {
    public var html: String
    public var app: AppSummary
}

/// A change to one app's records or details, from the event stream.
public struct AppChange: Codable, Hashable, Sendable {
    public var appId: String
    public var botId: String
    public var rev: Int
    public var collections: [String]
    public var by: String?
    public var deleted: Bool?
    public var meta: Bool?
}

public struct MiniAppManifest: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var version: String
    public var description: String?
    public var author: String?
    public var icon: String?
    public var collections: [String: String]
}

public struct InstallPreview: Codable, Hashable, Sendable {
    public struct Existing: Codable, Hashable, Sendable { public var appId: String; public var version: String }
    public var manifest: MiniAppManifest
    public var source: String
    public var host: String
    public var builtin: Bool
    public var bytes: Int
    /// bots that already run this app: botId → its app and version
    public var existing: [String: Existing]
}

public struct InstallPreviewResponse: Codable, Sendable {
    public var token: String
    public var preview: InstallPreview
}

public struct InstallResult: Codable, Sendable {
    public var app: AppSummary
    public var updated: Bool
}

// MARK: - Rules (shared/apps.ts, shared/mini-apps.ts)

public enum MiniApps {
    public static let recordBytes = 256 * 1024
    public static let neverLine = "no internet. it can't see your chats, files, keys or other apps."

    public static func validAppId(_ id: String) -> Bool { id.wholeMatch(of: #/a-[a-z0-9]{12}/#) != nil }

    /// "constructor", "toString", "__proto__" would reach Object.prototype on the computer.
    private static let reserved: Set<String> = [
        "constructor", "__proto__", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__",
        "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "toString", "valueOf",
    ]
    public static func validCollection(_ name: String) -> Bool {
        name.wholeMatch(of: #/[a-z][a-z0-9_-]{0,39}/#) != nil && !reserved.contains(name)
    }
    public static func validRecordId(_ id: String) -> Bool {
        id.wholeMatch(of: #/[A-Za-z0-9_-]{1,64}/#) != nil && !reserved.contains(id)
    }

    /// A pasted or shared link → the url the computer fetches. Accepts
    /// bosbot.my/a/crm without the scheme; https only, no credentials.
    public static func normalizeInstallURL(_ input: String) -> String? {
        let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, raw.count <= 2000, !raw.contains(where: \.isWhitespace) else { return nil }
        let hasScheme = raw.range(of: #"^[a-zA-Z][a-zA-Z0-9+.-]*:"#, options: .regularExpression) != nil
        guard var parts = URLComponents(string: hasScheme ? raw : "https://\(raw)"),
              parts.scheme?.lowercased() == "https", parts.user == nil, parts.password == nil,
              let host = parts.host, !host.isEmpty
        else { return nil }
        parts.scheme = "https"
        parts.fragment = nil
        if parts.path.isEmpty { parts.path = "/" }
        return parts.url?.absoluteString
    }

    /// A bosbot.my/a/… link in shared or pasted text, if there is one.
    public static func installLink(in text: String) -> String? {
        guard let match = text.firstMatch(of: #/(?:https:\/\/)?(?:www\.)?bosbot\.my\/a\/[A-Za-z0-9._~\/-]+/#) else { return nil }
        return normalizeInstallURL(String(match.output))
    }

    /// What the install sheet says the app can do (permissionLines).
    public static func permissionLine(collections: [String: String], botName: String) -> (text: String, detail: String) {
        let names = collections.keys.sorted()
        let text = names.isEmpty ? "keep its own records"
            : "keep its own \(names.prefix(4).joined(separator: ", "))\(names.count > 4 ? "…" : "")"
        return (text, "only this app's data. \(botName) can read and change it too.")
    }
}

// MARK: - Bridge

public enum BridgeOp: String, Sendable { case list, get, put, patch, remove
    public var writes: Bool { self == .put || self == .patch || self == .remove }
}

public struct BridgeRequest: Hashable, Sendable {
    public var rid: Int
    public var op: BridgeOp
    public var collection: String
    public var id: String?
    public var record: [String: JSONValue]?
    public var fields: [String: JSONValue]?
}

public enum BridgeParse: Hashable, Sendable {
    case request(BridgeRequest)
    /// rid is nil when the page sent something with no usable request id: no reply is possible.
    case invalid(rid: Int?, error: String)
}

public enum MiniAppBridge {
    /// One message from the page: `{app:{rid, op, collection, id?, record?, fields?}}`,
    /// `{appHello:true}`, or something to drop. `frameId` must match `bosCanvas`.
    public enum Message: Hashable, Sendable { case hello, call(BridgeParse), ignore }

    public static func message(_ body: Any, frameId: String) -> Message {
        guard let object = body as? [String: Any], object["bosCanvas"] as? String == frameId else { return .ignore }
        if let hello = object["appHello"] as? Bool, hello { return .hello }
        guard let app = object["app"] else { return .ignore }
        return .call(parse(app))
    }

    public static func parse(_ raw: Any) -> BridgeParse {
        guard let object = raw as? [String: Any] else { return .invalid(rid: nil, error: "bad request") }
        guard let number = object["rid"] as? NSNumber, !isBool(number),
              number.doubleValue == number.doubleValue.rounded(), abs(number.doubleValue) < 9e15
        else { return .invalid(rid: nil, error: "bad request id") }
        let rid = number.intValue
        guard let opName = object["op"] as? String, let op = BridgeOp(rawValue: opName) else {
            return .invalid(rid: rid, error: "op must be one of list, get, put, patch, remove")
        }
        guard let collection = object["collection"] as? String, MiniApps.validCollection(collection) else {
            return .invalid(rid: rid, error: "collection must be a short lowercase name like contacts")
        }
        var out = BridgeRequest(rid: rid, op: op, collection: collection)
        if op == .get || op == .patch || op == .remove || (object["id"] != nil && !(object["id"] is NSNull)) {
            guard let id = object["id"] as? String, MiniApps.validRecordId(id) else {
                return .invalid(rid: rid, error: "id must be 1-64 letters, digits, _ or -")
            }
            out.id = id
        }
        if op == .put {
            guard let record = object["record"] as? [String: Any], let value = json(record), case let .object(fields) = value else {
                return .invalid(rid: rid, error: "put needs a record object")
            }
            out.record = fields
        }
        if op == .patch {
            guard let raw = object["fields"] as? [String: Any], let value = json(raw), case let .object(fields) = value else {
                return .invalid(rid: rid, error: "patch needs a fields object")
            }
            out.fields = fields
        }
        if let body = out.record ?? out.fields, JSONValue.object(body).jsonString().utf8.count > MiniApps.recordBytes {
            return .invalid(rid: rid, error: "a record can be at most \(MiniApps.recordBytes / 1024) KB")
        }
        return .request(out)
    }

    /// The write the computer's /data route takes for one bridge request (runBridge in CanvasTab.tsx).
    public static func writeOp(_ request: BridgeRequest) -> [String: JSONValue]? {
        var op: [String: JSONValue] = ["collection": .string(request.collection)]
        switch request.op {
        case .put:
            op["op"] = .string("put")
            op["record"] = .object(request.record ?? [:])
            if let id = request.id { op["id"] = .string(id) }
        case .patch:
            op["op"] = .string("patch")
            op["id"] = request.id.map(JSONValue.string)
            op["fields"] = .object(request.fields ?? [:])
        case .remove:
            op["op"] = .string("delete")
            op["id"] = request.id.map(JSONValue.string)
        case .list, .get:
            return nil
        }
        return op
    }

    /// `window.postMessage({bosCanvas, appReply:{rid, ok, value|error}}, "*")`, as script text.
    public enum Reply: Hashable, Sendable { case value(JSONValue), error(String) }

    public static func replyScript(frameId: String, rid: Int, result: Reply) -> String {
        var reply: [String: JSONValue] = ["rid": .number(Double(rid))]
        switch result {
        case let .value(value): reply["ok"] = .bool(true); reply["value"] = value
        case let .error(error): reply["ok"] = .bool(false); reply["error"] = .string(error)
        }
        return post(frameId: frameId, ["appReply": .object(reply)])
    }

    public static func initScript(frameId: String, appId: String, name: String, theme: String) -> String {
        post(frameId: frameId, ["appInit": .object([
            "app": .object(["id": .string(appId), "name": .string(name)]),
            "theme": .string(theme),
        ])])
    }

    public static func changedScript(frameId: String, collections: [String], all: Bool = false) -> String {
        var changed: [String: JSONValue] = ["collections": .array(collections.map(JSONValue.string))]
        if all { changed["all"] = .bool(true) }
        return post(frameId: frameId, ["appChanged": .object(changed)])
    }

    private static func post(frameId: String, _ payload: [String: JSONValue]) -> String {
        var message = payload
        message["bosCanvas"] = .string(frameId)
        // jsonString escapes quotes and control characters; U+2028/9 are
        // valid json but end a line in older script engines.
        let text = JSONValue.object(message).jsonString()
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "window.postMessage(\(text),\"*\");"
    }

    private static func isBool(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }

    /// Foundation's JSON objects (what WKScriptMessage gives) → JSONValue.
    static func json(_ any: Any, depth: Int = 0) -> JSONValue? {
        guard depth < 64 else { return nil }
        switch any {
        case is NSNull: return .null
        case let number as NSNumber:
            if isBool(number) { return .bool(number.boolValue) }
            let value = number.doubleValue
            return value.isFinite ? .number(value) : nil
        case let string as String: return .string(string)
        case let array as [Any]:
            var out: [JSONValue] = []
            for item in array { guard let value = json(item, depth: depth + 1) else { return nil }; out.append(value) }
            return .array(out)
        case let dict as [String: Any]:
            var out: [String: JSONValue] = [:]
            for (key, item) in dict { guard let value = json(item, depth: depth + 1) else { return nil }; out[key] = value }
            return .object(out)
        default: return nil
        }
    }
}

// MARK: - Kit

/// The policy, WebRTC strip, design kit and bridge the desktop tab gives an
/// app, generated from the desktop source into Resources/mini-app-kit.json
/// (`UPDATE_IOS_KIT=1 vitest run src/components/canvas/mini-app.test.ts`).
public struct MiniAppKit: Codable, Sendable {
    public var csp: String
    public var noRtc: String
    public var kitCss: String
    public var bridge: String

    public static let bundled: MiniAppKit? = Bundle.module.url(forResource: "mini-app-kit", withExtension: "json")
        .flatMap { try? Data(contentsOf: $0) }
        .flatMap { try? JSONDecoder().decode(MiniAppKit.self, from: $0) }

    public init(csp: String, noRtc: String, kitCss: String, bridge: String) {
        self.csp = csp; self.noRtc = noRtc; self.kitCss = kitCss; self.bridge = bridge
    }

    /// The page as the webview loads it: the no-network policy is the very
    /// first element, ahead of anything the app wrote (miniAppDocument).
    public func document(html: String) -> String {
        let attribute = csp.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
        let css = kitCss.replacingOccurrences(of: "</style", with: "<\\/style", options: .caseInsensitive)
        let body = html.replacingOccurrences(of: #"^\s*<!doctype[^>]*>"#, with: "", options: [.regularExpression, .caseInsensitive])
        return "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"\(attribute)\"><meta charset=\"utf-8\"><meta name=\"referrer\" content=\"no-referrer\">"
            + "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
            + "<style>\(css)</style>" + body
    }

    /// The bridge script for one opened app; `frameId` is json-quoted in.
    public func bridgeScript(frameId: String) -> String {
        bridge.replacingOccurrences(of: "__ID__", with: JSONValue.string(frameId).jsonString())
    }
}

// MARK: - Offline copy

/// The last page and records the phone loaded for each app, so an app opens
/// read-only while the computer is away. One folder per computer; names are
/// checked ids, so nothing the server or page sends can pick a path.
public struct MiniAppCache: Sendable {
    public let root: URL

    public init(root: URL) { self.root = root }

    private func folder(_ appId: String) -> URL? {
        MiniApps.validAppId(appId) ? root.appendingPathComponent(appId, isDirectory: true) : nil
    }

    public func savePage(_ page: AppPage) {
        guard let dir = folder(page.app.id) else { return }
        write(page, to: dir.appendingPathComponent("page.json"))
    }

    public func page(_ appId: String) -> AppPage? {
        guard let dir = folder(appId) else { return nil }
        return read(AppPage.self, from: dir.appendingPathComponent("page.json"))
    }

    public func saveRecords(_ records: [JSONValue], appId: String, collection: String) {
        guard let dir = folder(appId), MiniApps.validCollection(collection) else { return }
        write(records, to: dir.appendingPathComponent("records", isDirectory: true).appendingPathComponent("\(collection).json"))
    }

    public func records(appId: String, collection: String) -> [JSONValue]? {
        guard let dir = folder(appId), MiniApps.validCollection(collection) else { return nil }
        return read([JSONValue].self, from: dir.appendingPathComponent("records", isDirectory: true).appendingPathComponent("\(collection).json"))
    }

    public func saveList(_ apps: [AppSummary]) { write(apps, to: root.appendingPathComponent("apps.json")) }
    public func list() -> [AppSummary]? { read([AppSummary].self, from: root.appendingPathComponent("apps.json")) }

    public func remove(_ appId: String) {
        guard let dir = folder(appId) else { return }
        try? FileManager.default.removeItem(at: dir)
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {}
    }

    private func read<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
