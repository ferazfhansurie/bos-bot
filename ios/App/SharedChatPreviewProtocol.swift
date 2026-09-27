#if DEBUG
import Foundation

/// A synthetic native UI fixture. All requests are intercepted, including
/// unknown routes, so preview mode cannot contact a real host or provider.
final class SharedChatPreviewProtocol: URLProtocol {
    private static let fixture = SharedChatPreviewState()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let url = request.url else { return }
        let (status, payload) = Self.fixture.response(request)
        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotDecodeContentData)); return
        }
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class SharedChatPreviewState: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled: Set<String> = []
    private let owner = "preview-home:person:owner"
    private let teammate = "preview-maya:person:owner"
    private let roomId = "preview-shared-room"
    private let at = Date().timeIntervalSince1970 * 1000 - 1_000_000
    private var image: Data { Bundle.main.url(forResource: "ImagePreview", withExtension: "png").flatMap { try? Data(contentsOf: $0) } ?? Data() }
    private var attachment: [String: Any] { ["id": "launch-board", "name": "launch-board.png", "mime": "image/png", "size": image.count] }
    private func actor(_ person: Bool = true, home: String = "preview-home") -> [String: String] {
        ["homeId": home, "kind": person ? "person" : "bot", "localId": person ? "owner" : "pepper"]
    }
    private var messages: [[String: Any]] {
        (1...220).map { sequence in
            var row: [String: Any] = ["id": "shared-message-\(sequence)", "roomId": roomId, "sequence": sequence,
                "actor": sequence == 219 ? actor(false) : actor(true, home: sequence.isMultiple(of: 2) ? "preview-home" : "preview-maya"),
                "text": "Team update \(sequence): the launch checklist is ready for review. We can discuss the next step here.",
                "at": at + Double(sequence * 1000), "sendId": "shared-send-\(sequence)"]
            if sequence == 1 { row["text"] = "Original launch board for the team."; row["attachments"] = [attachment] }
            if sequence == 216 { row["text"] = "@Pepper prepare the next draft" }
            if sequence == 217 { row["text"] = "@Willow review the checklist" }
            if sequence == 218 { row["text"] = "@Pepper summarize our launch plan" }
            if sequence == 219 { row["text"] = "The launch plan is ready: invite the team, share the board, and review the first bot result."; row["responseTo"] = "shared-message-218" }
            if sequence == 220 { row["text"] = "Latest message — ready for the alpha walkthrough." }
            return row
        }
    }
    private func botRequest(_ id: String, source: Int, state: String, other: Bool = false) -> [String: Any] {
        var value: [String: Any] = ["id": id, "roomId": roomId, "sourceId": "shared-message-\(source)", "sourceSequence": source,
            "requesterId": other ? teammate : owner, "botId": other ? "preview-maya:bot:willow" : "preview-home:bot:pepper",
            "botName": other ? "Willow" : "Pepper", "ownerId": other ? teammate : owner, "ownerName": other ? "Maya" : "Alex",
            "state": cancelled.contains(id) ? "cancelled" : state, "createdAt": at + Double(source * 1000), "updatedAt": at + 220_000]
        if cancelled.contains(id) { value["explanation"] = "Cancelled before the bot started." }
        if state == "completed" { value["resultId"] = "shared-message-219"; value["resultSequence"] = 219 }
        return value
    }
    func response(_ request: URLRequest) -> (Int, [String: Any]) {
        lock.lock(); defer { lock.unlock() }
        guard request.url?.host == "shared-preview.invalid", request.value(forHTTPHeaderField: "Authorization") == "Bearer shared-preview-token" else {
            return (403, ["error": "Offline fixture refused this request"])
        }
        let path = request.url!.path
        let method = request.httpMethod ?? "GET"
        let query = Dictionary((URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _, new in new })
        let roomPath = "/api/multiplayer/rooms/\(roomId)"
        if path == "/api/multiplayer/me" { return (200, ["actorId": owner, "homeId": "preview-home", "name": "Alex"]) }
        if path == "/api/multiplayer/contacts" { return (200, ["contacts": [["id": owner, "name": "Alex", "kind": "person"], ["id": teammate, "name": "Maya", "kind": "person"]]]) }
        if path == "/api/multiplayer/rooms" && method == "GET" {
            return (200, ["rooms": [["id": roomId, "homeId": "preview-home", "name": "Launch crew", "kind": "group", "createdBy": owner,
                "memberIds": [owner, teammate], "createdAt": at, "lastActivity": at + 220_000, "preview": "Ready for the alpha walkthrough.", "revision": 1]]])
        }
        if path == roomPath + "/bots" { return (200, ["bots": [["id": "preview-home:bot:pepper", "name": "Pepper", "ownerName": "Alex"], ["id": "preview-maya:bot:willow", "name": "Willow", "ownerName": "Maya", "availability": "ready"]]]) }
        if path == roomPath + "/preferences" { return (200, ["readSequence": 220, "notifications": "all"]) }
        if path == roomPath + "/messages" && method == "GET" {
            let limit = min(200, max(1, Int(query["limit"] ?? "200") ?? 200))
            let rows: [[String: Any]]
            if let before = Int(query["before"] ?? "") { rows = Array(messages.filter { ($0["sequence"] as! Int) < before }.suffix(limit)) }
            else if query["latest"] == "1" { rows = Array(messages.suffix(limit)) }
            else { let after = Int(query["after"] ?? "0") ?? 0; rows = Array(messages.filter { ($0["sequence"] as! Int) > after }.prefix(limit)) }
            return (200, ["messages": rows, "changes": [], "version": 0, "hasMore": (rows.first?["sequence"] as? Int ?? 1) > 1])
        }
        if path == roomPath + "/files" { return (200, ["files": [["attachment": attachment, "messageId": "shared-message-1", "sequence": 1, "actor": actor(true, home: "preview-maya"), "at": at]], "hasMore": false, "before": 1]) }
        if path == roomPath + "/attachments/launch-board" { return (200, ["attachment": attachment, "data": image.base64EncodedString()]) }
        if path == roomPath + "/requests" { return (200, ["requests": [botRequest("complete", source: 218, state: "completed"), botRequest("teammate", source: 217, state: "working", other: true), botRequest("queued", source: 216, state: "queued")], "hasMore": false, "before": 216]) }
        if path == roomPath + "/requests/queued/cancel" && method == "POST" { cancelled.insert("queued"); return (200, ["request": botRequest("queued", source: 216, state: "queued")]) }
        return (404, ["error": "This route is unavailable in the offline fixture"])
    }
}
#endif
