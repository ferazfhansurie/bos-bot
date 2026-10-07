import Foundation

/// The /v2 routes the phone calls, as shared/cloud-protocol/README.md lists them.
public enum CloudRoute {
    public static let discovery = "/v2/discovery/sync"
    public static let me = "/v2/me"
    public static let workspaces = "/v2/workspaces"
    public static let redeemInvite = "/v2/invites/redeem"

    public static func rooms(workspaceId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/rooms"
    }
    public static func invites(workspaceId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/invites"
    }
    public static let realtime = "/v2/realtime"

    public static func operationWindows(workspaceId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/operation-windows"
    }
    public static func send(workspaceId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/messages"
    }
    public static func operation(workspaceId: String, operationId: CloudOperationID) -> String {
        "/v2/workspaces/\(escape(workspaceId))/operations/\(escape(operationId.rawValue))"
    }
    public static func resolveNotAccepted(workspaceId: String, operationId: CloudOperationID) -> String {
        operation(workspaceId: workspaceId, operationId: operationId) + "/resolve-not-accepted"
    }
    public static func snapshot(workspaceId: String, roomId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/rooms/\(escape(roomId))/snapshot"
    }
    public static func read(workspaceId: String, roomId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/rooms/\(escape(roomId))/read"
    }

    public static func approval(workspaceId: String, roomId: String, approvalId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/rooms/\(escape(roomId))/approvals/\(escape(approvalId))"
    }
    public static func decision(workspaceId: String, roomId: String, approvalId: String) -> String {
        approval(workspaceId: workspaceId, roomId: roomId, approvalId: approvalId) + "/decision"
    }
    public static func attachments(workspaceId: String) -> String {
        "/v2/workspaces/\(escape(workspaceId))/attachments"
    }
    public static func attachment(workspaceId: String, attachmentId: String, _ action: String) -> String {
        attachments(workspaceId: workspaceId) + "/\(escape(attachmentId))/\(action)"
    }

    static func escape(_ segment: String) -> String {
        segment.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? segment
    }
}

/// Maps an HTTP answer to what the outbox can act on. Only the server's
/// explicit verdict is definitive; identity and transport failures never are.
public enum CloudResponseClassifier {
    public static func submit(status: Int, body: Data, retryAfterHeader: String?) -> CloudSubmitResult {
        switch status {
        case 200...299:
            guard let outcome = try? JSONDecoder().decode(CloudOperationOutcome.self, from: body) else { return .indeterminate }
            return .outcome(outcome)
        case 429:
            return .rateLimited(retryAfter: retryAfter(body: body, header: retryAfterHeader))
        default:
            guard let code = decodeError(body)?.error else { return .indeterminate }
            if definitiveRejections.contains(code) {
                return .outcome(.rejected(CloudRejection(clientOperationId: "", digest: nil, reason: code)))
            }
            // operation_conflict means this key already holds different
            // bytes; only reconciliation decides what happened.
            if code == .operationConflict || code == .recoveryUnknown { return .outcome(.recoveryUnknown) }
            // Anything else, denials included, is settled by lookup.
            return .indeterminate
        }
    }

    /// Transport failures that mean no byte left the device. Timeouts and
    /// dropped connections are not here: those may have reached the server.
    public static let neverSent: Set<URLError.Code> = [.notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff]

    /// Error bodies that prove the send was refused before admission.
    static let definitiveRejections: Set<CloudErrorCode> = [
        .invalidRequest, .invalidMention, .unsupportedAttachment, .invalidReply, .operationExpired, .policyChanged,
    ]

    public static func lookup(status: Int, body: Data, retryAfterHeader: String?) -> CloudSubmitResult {
        switch status {
        case 200...299:
            guard let outcome = try? JSONDecoder().decode(CloudOperationOutcome.self, from: body) else { return .indeterminate }
            return .outcome(outcome)
        case 429:
            return .rateLimited(retryAfter: retryAfter(body: body, header: retryAfterHeader))
        default:
            // A denial or outage is never proof the send did not commit.
            return .indeterminate
        }
    }

    public static func decodeError(_ body: Data) -> CloudError? {
        try? JSONDecoder().decode(CloudError.self, from: body)
    }

    static func retryAfter(body: Data, header: String?) -> TimeInterval {
        if let seconds = decodeError(body)?.retryAfter { return seconds }
        if let header, let seconds = Double(header) { return seconds }
        return 1
    }
}

public struct CloudCreatedWorkspace: Hashable, Decodable, Sendable {
    public var workspaceId: String
    public var role: CloudRole
    enum CodingKeys: String, CodingKey { case workspaceId = "workspace_id", role }
}

public struct CloudCreatedRoom: Hashable, Decodable, Sendable {
    public var roomId: String
    public var threadId: String
    public var policyRevision: CloudSequence
    enum CodingKeys: String, CodingKey { case roomId = "room_id", threadId = "thread_id", policyRevision = "policy_revision" }
}

public struct CloudInvite: Hashable, Decodable, Sendable {
    public var inviteId: String
    public var token: String
    public var expiresAt: String
    enum CodingKeys: String, CodingKey { case inviteId = "invite_id", token, expiresAt = "expires_at" }
}

public struct CloudRedeemed: Hashable, Decodable, Sendable {
    public var workspaceId: String
    public var role: CloudRole
    public var roomIds: [String]
    enum CodingKeys: String, CodingKey { case workspaceId = "workspace_id", role, roomIds = "room_ids" }
}

/// HTTP and realtime calls for one signed-in account. Requests carry a 10
/// second deadline; the bearer comes from the session, never from storage
/// shared with another account.
public final class CloudClient: @unchecked Sendable {
    public let baseURL: URL
    private let session: URLSession
    private let bearer: @Sendable () async throws -> String
    /// False fails every call as offline before any I/O; debug builds use it
    /// to take the room service away without touching the device network.
    private let reachable: @Sendable () -> Bool

    public init(baseURL: URL, session: URLSession = CloudIssuerClient.cookieless, reachable: @escaping @Sendable () -> Bool = { true }, bearer: @escaping @Sendable () async throws -> String) {
        self.baseURL = baseURL; self.session = session; self.reachable = reachable; self.bearer = bearer
    }

    public func me() async throws -> CloudIdentity {
        try await json(CloudRoute.me, method: "GET", body: nil as String?)
    }

    public func createWorkspace(name: String) async throws -> CloudCreatedWorkspace {
        try await json(CloudRoute.workspaces, method: "POST", body: ["name": name])
    }

    public func createRoom(workspaceId: String, name: String) async throws -> CloudCreatedRoom {
        try await json(CloudRoute.rooms(workspaceId: workspaceId), method: "POST", body: ["name": name])
    }

    public func createInvite(workspaceId: String, role: CloudRole, roomIds: [String]) async throws -> CloudInvite {
        struct Body: Encodable { var role: CloudRole; var room_ids: [String] }
        return try await json(CloudRoute.invites(workspaceId: workspaceId), method: "POST", body: Body(role: role, room_ids: roomIds))
    }

    /// Explicit action only; never called from a link preview.
    public func redeemInvite(token: String) async throws -> CloudRedeemed {
        try await json(CloudRoute.redeemInvite, method: "POST", body: ["token": token])
    }

    public func discovery() async throws -> CloudDiscovery {
        try await json(CloudRoute.discovery, method: "GET", body: nil as String?)
    }

    public func operationWindow(workspaceId: String) async throws -> CloudSendWindow {
        try await json(CloudRoute.operationWindows(workspaceId: workspaceId), method: "POST", body: [String: String]())
    }

    public func submit(_ envelope: CloudSendEnvelope) async -> CloudSubmitResult {
        await ledger(CloudRoute.send(workspaceId: envelope.namespace.workspaceId), body: envelope, classify: CloudResponseClassifier.submit)
    }

    public func lookup(_ operation: CloudOperationID, workspaceId: String) async -> CloudSubmitResult {
        await ledger(CloudRoute.operation(workspaceId: workspaceId, operationId: operation), body: nil as CloudSendEnvelope?, classify: CloudResponseClassifier.lookup)
    }

    public func seal(_ envelope: CloudSendEnvelope) async -> CloudSubmitResult {
        await ledger(CloudRoute.resolveNotAccepted(workspaceId: envelope.namespace.workspaceId, operationId: envelope.clientOperationId), body: envelope, classify: CloudResponseClassifier.lookup)
    }

    public func snapshot(_ room: CloudRoomRef) async throws -> CloudSnapshot {
        try await json(CloudRoute.snapshot(workspaceId: room.workspaceId, roomId: room.roomId), method: "POST", body: ["thread_id": room.threadId])
    }

    public func markViewed(_ room: CloudRoomRef, intervals: [CloudReadInterval], markReadThrough: CloudSequence? = nil, attention: Bool? = nil) async throws -> CloudReadCoverage {
        struct Body: Encodable {
            var thread_id: String
            var intervals: [CloudReadInterval]
            var mark_read_through: CloudSequence?
            var attention: Bool?
        }
        return try await json(CloudRoute.read(workspaceId: room.workspaceId, roomId: room.roomId), method: "POST", body: Body(thread_id: room.threadId, intervals: intervals, mark_read_through: markReadThrough, attention: attention))
    }

    /// Online only: a decision is never queued or replayed.
    public func approval(_ room: CloudRoomRef, approvalId: String) async throws -> CloudApprovalCard {
        try await json(CloudRoute.approval(workspaceId: room.workspaceId, roomId: room.roomId, approvalId: approvalId), method: "GET", body: nil as String?)
    }

    public func decide(_ card: CloudApprovalCard, _ choice: CloudApprovalChoice) async throws -> CloudApprovalCard {
        try await json(CloudRoute.decision(workspaceId: card.workspaceId, roomId: card.roomId, approvalId: card.approvalId), method: "POST", body: card.decision(choice))
    }

    public func prepareAttachment(workspaceId: String, _ prepare: CloudAttachmentPrepare) async throws -> CloudAttachmentUpload {
        try await json(CloudRoute.attachments(workspaceId: workspaceId), method: "POST", body: prepare)
    }

    /// PUTs the bytes to the scoped upload URL. The bearer only ever goes to
    /// this client's own origin.
    public func upload(_ upload: CloudAttachmentUpload, bytes: Data) async throws {
        guard let url = URL(string: upload.uploadURL), Self.sameOrigin(url, baseURL) else { throw CloudError(.forbidden) }
        guard reachable() else { throw URLError(.notConnectedToInternet) }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "PUT"
        request.setValue(upload.attachment.type, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(try await bearer())", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.upload(for: request, from: bytes)
        try Self.check(response, data)
    }

    /// Server-side scan; ready or rejected. A scanner outage stays quarantined (503).
    public func completeAttachment(_ attachment: CloudAttachment) async throws -> CloudAttachment {
        try await json(CloudRoute.attachment(workspaceId: attachment.workspaceId, attachmentId: attachment.attachmentId, "complete"), method: "POST", body: [String: String]())
    }

    /// Raw bytes and the server's content type. Callers keep them in memory.
    public func download(workspaceId: String, attachmentId: String) async throws -> (data: Data, type: String) {
        var request = try await request(CloudRoute.attachment(workspaceId: workspaceId, attachmentId: attachmentId, "download"), method: "GET")
        request.timeoutInterval = 60
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await session.data(for: request)
        try Self.check(response, data)
        let type = ((response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type") ?? "").split(separator: ";").first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        guard CloudAttachmentLimits.types.contains(type) else { throw CloudError(.unsupportedAttachment) }
        return (data, type)
    }

    static func sameOrigin(_ a: URL, _ b: URL) -> Bool {
        a.scheme?.lowercased() == b.scheme?.lowercased() && a.host?.lowercased() == b.host?.lowercased() && (a.port ?? defaultPort(a)) == (b.port ?? defaultPort(b))
    }

    private static func defaultPort(_ url: URL) -> Int { url.scheme?.lowercased() == "https" ? 443 : 80 }

    private static func check(_ response: URLResponse, _ data: Data) throws {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            throw CloudResponseClassifier.decodeError(data) ?? CloudError(status >= 500 ? .unavailable : .invalidRequest)
        }
    }

    /// Opens the one multiplexed /v2/realtime socket: authenticate first,
    /// then one subscribe per room. Frames arrive in order with their own
    /// room ids; the stream ends on close, error or cancellation.
    public func realtime(subscriptions: [CloudOutboundFrame]) async throws -> AsyncThrowingStream<CloudFrame, Error> {
        guard reachable() else { throw URLError(.notConnectedToInternet) }
        var components = URLComponents(url: baseURL.appendingPathComponent(String(CloudRoute.realtime.dropFirst())), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        let task = session.webSocketTask(with: components.url!)
        task.resume()
        let encoder = JSONEncoder()
        for frame in [CloudOutboundFrame.authenticate(bearer: try await bearer())] + subscriptions.prefix(CloudLimits.subscriptions) {
            try await task.send(.string(String(decoding: try encoder.encode(frame), as: UTF8.self)))
        }
        return AsyncThrowingStream { continuation in
            let reader = Task {
                do {
                    while !Task.isCancelled {
                        let data: Data
                        switch try await task.receive() {
                        case .data(let bytes): data = bytes
                        case .string(let text): data = Data(text.utf8)
                        @unknown default: continue
                        }
                        continuation.yield(try JSONDecoder().decode(CloudFrame.self, from: data))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                reader.cancel()
                task.cancel(with: .goingAway, reason: nil)
            }
        }
    }

    private func ledger<Body: Encodable>(_ path: String, body: Body?, classify: (Int, Data, String?) -> CloudSubmitResult) async -> CloudSubmitResult {
        do {
            var request = try await request(path, method: body == nil ? "GET" : "POST")
            if let body { request.httpBody = try JSONEncoder().encode(body) }
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            return classify(http?.statusCode ?? 0, data, http?.value(forHTTPHeaderField: "Retry-After"))
        } catch let error as URLError where CloudResponseClassifier.neverSent.contains(error.code) {
            return .offline
        } catch {
            return .indeterminate
        }
    }

    private func json<T: Decodable, Body: Encodable>(_ path: String, method: String, body: Body?) async throws -> T {
        var request = try await request(path, method: method)
        if let body { request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            throw CloudResponseClassifier.decodeError(data) ?? CloudError(status >= 500 ? .unavailable : .invalidRequest)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func request(_ path: String, method: String) async throws -> URLRequest {
        guard reachable() else { throw URLError(.notConnectedToInternet) }
        var request = URLRequest(url: baseURL.appendingPathComponent(String(path.dropFirst())), timeoutInterval: CloudLimits.requestSeconds)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(try await bearer())", forHTTPHeaderField: "Authorization")
        return request
    }
}
