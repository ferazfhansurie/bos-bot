import Foundation

/// A second session of the app's own account, driven over raw HTTP (the UI
/// test target does not link CompanionCore). It registers a bot and the host
/// that runs it, @mentions the bot, and plays the host up to an approval
/// card, so the app has a card of its own to decide.
///
/// Order matters: registering a bot bumps every room's policy revision, so
/// call `firstRoom()` after `registerBot` and before `sendMention`.
///
/// Issuer limits (cloudflare/control-plane): at most 3 code requests per
/// address per 15 minutes (0003_otp_recipient_rate_limits); past that the
/// issuer answers success and sends nothing, so the app's sign-in plus this
/// one leaves one spare. Better Auth also allows 5 sends and 10 verifies per
/// minute per client IP, and locally (no cf-connecting-ip) every caller
/// shares one bucket; a 429 here waits out X-Retry-After.
final class CloudHostDriver {
    struct Failure: Error, CustomStringConvertible { let description: String }

    let rooms: URL
    private let bearer: String

    /// Like CloudIssuerClient.cookieless: the issuer refuses cookie-bearing
    /// requests without a browser Origin.
    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        return URLSession(configuration: config)
    }()

    private init(rooms: URL, bearer: String) { self.rooms = rooms; self.bearer = bearer }

    // MARK: - sign-in

    /// Email OTP exactly as CloudIssuerClient: send-verification-otp, then
    /// sign-in/email-otp; the signed bearer is the `set-auth-token` header.
    /// The dev sink keeps the last code per address and the issuer sends in
    /// the background, so it may still hold the app's spent code for a
    /// moment: a rejected code is retried only once the sink shows a new one.
    static func signIn(email raw: String, issuer: URL, rooms: URL, otp: (String) async throws -> String) async throws -> CloudHostDriver {
        let email = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let (sent, _, _) = try await issuerCall(issuer, "api/auth/email-otp/send-verification-otp", ["email": email, "type": "sign-in"])
        guard (200...299).contains(sent) else { throw Failure(description: "otp request -> \(sent)") }
        let name = String(email.prefix { $0 != "@" })
        var tried: Set<String> = []
        for _ in 0..<3 {
            var code = try await otp(email)
            var polls = 0
            while tried.contains(code), polls < 20 {
                try await Task.sleep(nanoseconds: 250_000_000)
                code = try await otp(email); polls += 1
            }
            guard !tried.contains(code) else { break }
            tried.insert(code)
            let (status, data, response) = try await issuerCall(issuer, "api/auth/sign-in/email-otp", ["email": email, "otp": code, "name": name])
            if (400...403).contains(status) { continue }
            guard (200...299).contains(status) else { throw Failure(description: "otp verify -> \(status)") }
            struct Body: Decodable { struct User: Decodable { var email: String }; var user: User }
            guard let bearer = response?.value(forHTTPHeaderField: "set-auth-token"),
                  (16...4096).contains(bearer.count), bearer.allSatisfy({ $0.isASCII && !$0.isWhitespace }),
                  (try? JSONDecoder().decode(Body.self, from: data))?.user.email.lowercased() == email
            else { throw Failure(description: "otp verify: no usable set-auth-token or user") }
            return CloudHostDriver(rooms: rooms, bearer: bearer)
        }
        throw Failure(description: "otp verify rejected every code the dev sink returned for \(email)")
    }

    private static func issuerCall(_ issuer: URL, _ path: String, _ body: [String: String]) async throws -> (Int, Data, HTTPURLResponse?) {
        var request = URLRequest(url: issuer.appendingPathComponent(path), timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        for attempt in 0..<4 {
            let (data, response) = try await session.data(for: request)
            let http = response as? HTTPURLResponse
            let status = http?.statusCode ?? 0
            if status == 429, attempt < 3 {
                let header = http?.value(forHTTPHeaderField: "X-Retry-After") ?? http?.value(forHTTPHeaderField: "Retry-After")
                let wait = min(65, header.flatMap(Double.init) ?? 5)
                try await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
                continue
            }
            return (status, data, http)
        }
        return (429, Data(), nil)
    }

    // MARK: - room service

    /// The single workspace/room the test created. Thread and policy
    /// revision come from a fresh snapshot.
    func firstRoom() async throws -> (workspace: String, room: String, thread: String, policyRevision: String) {
        let (_, sync) = try await call("GET", "v2/discovery/sync")
        for w in sync["workspaces"] as? [[String: Any]] ?? [] {
            guard let workspace = w["workspace_id"] as? String,
                  let row = (w["rooms"] as? [[String: Any]])?.first,
                  let room = row["room_id"] as? String, let thread = row["thread_id"] as? String
            else { continue }
            let (_, snap) = try await call("POST", "v2/workspaces/\(workspace)/rooms/\(room)/snapshot", ["thread_id": thread])
            guard let policy = snap["policy_revision"] as? String else { throw Failure(description: "snapshot without policy_revision") }
            return (workspace, room, thread, policy)
        }
        throw Failure(description: "discovery found no room for this account")
    }

    /// A replay cursor at the room's head right now.
    func cursor(workspace: String, room: String, thread: String) async throws -> String {
        let (_, snap) = try await call("POST", "v2/workspaces/\(workspace)/rooms/\(room)/snapshot", ["thread_id": thread])
        guard let cursor = snap["cursor"] as? String else { throw Failure(description: "snapshot without cursor") }
        return cursor
    }

    /// The committed event id of `kind` after `cursor`, as replay returns it:
    /// what a push hint for that event carries.
    func eventId(workspace: String, room: String, thread: String, after cursor: String, kind: String = "message.created") async throws -> String {
        let (_, batch) = try await call("POST", "v2/workspaces/\(workspace)/rooms/\(room)/replay", ["thread_id": thread, "cursor": cursor])
        guard batch["type"] as? String == "event_batch" else { throw Failure(description: "replay -> \(batch["type"] as? String ?? "?")") }
        guard let id = (batch["events"] as? [[String: Any]])?.last(where: { $0["kind"] as? String == kind })?["event_id"] as? String
        else { throw Failure(description: "replay has no \(kind) event") }
        return id
    }

    /// Owner or admin only. The bot's owner is this account.
    func registerBot(workspace: String, room: String, botId: String, name: String) async throws {
        let model: [String: Any] = ["provider": "fixture", "model": "approval-driver", "config_revision": "1"]
        try await call("POST", "v2/workspaces/\(workspace)/bots", ["bot_id": botId, "name": name, "room_ids": [room], "model": model])
    }

    /// Owner or admin only, and every bot must be owned by this account.
    func registerHost(workspace: String, botIds: [String]) async throws -> (hostId: String, credential: String) {
        let (_, value) = try await call("POST", "v2/workspaces/\(workspace)/hosts", ["name": "ui-test host", "bot_ids": botIds, "capabilities": ["cooperative_read_only"]])
        guard let host = value["host_id"] as? String, let credential = value["host_credential"] as? String
        else { throw Failure(description: "host registration without host_id/host_credential") }
        return (host, credential)
    }

    /// A human send from this account that mentions `@botId`; the server
    /// offers one invocation per mentioned bot in the same transaction.
    /// Returns the accepted message id.
    func sendMention(workspace: String, room: String, thread: String, policyRevision: String, text: String, botId: String) async throws -> String {
        let span = (text as NSString).range(of: "@" + botId)
        guard span.location != NSNotFound else { throw Failure(description: "text does not contain @\(botId)") }
        return try await send(workspace: workspace, room: room, thread: thread, policyRevision: policyRevision, text: text,
                              mentions: [["kind": "bot", "id": botId, "start": span.location, "end": span.location + span.length]])
    }

    /// A plain human send from this account. Returns the accepted message id.
    func send(workspace: String, room: String, thread: String, policyRevision: String, text: String, mentions: [[String: Any]] = []) async throws -> String {
        let (_, window) = try await call("POST", "v2/workspaces/\(workspace)/operation-windows", [String: Any]())
        guard let namespace = window["namespace"] as? [String: Any], let windowId = window["window_id"] as? String,
              let token = window["window_token"] as? String
        else { throw Failure(description: "operation window missing namespace/window_id/window_token") }
        // The server requires the id to start with the window id, and the
        // namespace to equal the window's byte for byte.
        let operationId = windowId + "." + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let envelope: [String: Any] = [
            "kind": "message.send", "namespace": namespace, "client_operation_id": operationId,
            "window_token": token, "room_id": room, "thread_id": thread, "text": text,
            "mentions": mentions,
            "attachment_ids": [String](), "reply_to_message_id": NSNull(), "expected_policy_revision": policyRevision,
        ]
        let (_, outcome) = try await call("POST", "v2/workspaces/\(workspace)/messages", envelope)
        guard outcome["status"] as? String == "accepted", let message = outcome["message_id"] as? String else {
            let reason = outcome["reason"] as? String ?? outcome["status"] as? String ?? "?"
            let hint = reason == "policy_changed" ? " (call firstRoom() after registerBot)" : ""
            throw Failure(description: "send not accepted: \(reason)\(hint)")
        }
        return message
    }

    /// Host side: wait for the offer, claim it, checkpoint (pre-provider,
    /// replay_safe false), then ask the source actor, this account, to
    /// approve a random effect. Must finish inside the 30 second lease.
    func claimAndRequestApproval(workspace: String, hostId: String, credential: String, title: String, expiresIn: Int, messageId: String? = nil) async throws -> (invocationId: String, approvalId: String) {
        let base = "v2/workspaces/\(workspace)/hosts/\(hostId)"
        var offered: [String: Any]?
        for _ in 0..<20 {
            let (_, list) = try await call("GET", base + "/invocations", host: credential)
            offered = (list["invocations"] as? [[String: Any]])?.first { inv in
                inv["state"] as? String == "queued"
                    && (messageId == nil || (inv["source"] as? [String: Any])?["message_id"] as? String == messageId)
            }
            if offered != nil { break }
            try await Task.sleep(nanoseconds: 500_000_000)
        }
        guard let invocation = offered?["invocation_id"] as? String else { throw Failure(description: "no invocation offered to host within 10s") }
        let (_, claimed) = try await call("POST", base + "/claim", ["invocation_id": invocation], host: credential)
        guard let attempt = claimed["attempt"] as? Int, let fence = claimed["fence_gen"] as? String,
              let actor = (claimed["source"] as? [String: Any])?["actor_id"] as? String
        else { throw Failure(description: "claim without attempt/fence_gen/source.actor_id") }
        let binding: [String: Any] = ["invocation_id": invocation, "attempt": attempt, "fence_gen": fence]
        try await call("POST", base + "/events", binding.merging(["kind": "checkpoint", "replay_safe": false]) { $1 }, host: credential)
        let hex = { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
        let approval: [String: Any] = ["actor_id": actor, "effect_id": "effect-" + hex(), "digest": hex() + hex(), "title": title, "expires_in_seconds": expiresIn]
        let (_, created) = try await call("POST", base + "/events", binding.merging(["kind": "approval.create", "approval": approval]) { $1 }, host: credential)
        guard let id = created["approval_id"] as? String else { throw Failure(description: "approval.create returned no approval_id") }
        return (invocation, id)
    }

    /// Decides as this account from the card's current binding. Never throws
    /// on an HTTP status: 409 bodies carry approval_decided, approval_expired
    /// or control_conflict.
    func decide(workspace: String, room: String, approvalId: String, decision: String) async throws -> (status: Int, body: [String: Any]) {
        let card = try await self.card(workspace: workspace, room: room, approvalId: approvalId)
        var body: [String: Any] = ["decision": decision]
        for key in ["invocation_id", "attempt", "fence_gen", "version", "effect_id", "digest"] { body[key] = card[key] }
        return try await call("POST", "v2/workspaces/\(workspace)/rooms/\(room)/approvals/\(approvalId)/decision", body, check: false)
    }

    /// The card as the room service shows it to this account.
    func card(workspace: String, room: String, approvalId: String) async throws -> [String: Any] {
        try await call("GET", "v2/workspaces/\(workspace)/rooms/\(room)/approvals/\(approvalId)").body
    }

    /// One JSON call. Errors name the route, status and server error code,
    /// never the bearer or host credential.
    @discardableResult
    private func call(_ method: String, _ path: String, _ body: [String: Any]? = nil, host credential: String? = nil, check: Bool = true) async throws -> (status: Int, body: [String: Any]) {
        var request = URLRequest(url: rooms.appendingPathComponent(path), timeoutInterval: 10)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if let credential { request.setValue(credential, forHTTPHeaderField: "X-Cloud-Host-Credential") }
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await Self.session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        if check, !(200...299).contains(status) {
            throw Failure(description: "\(method) /\(path) -> \(status) \(value["error"] as? String ?? "no error code")")
        }
        return (status, value)
    }
}
