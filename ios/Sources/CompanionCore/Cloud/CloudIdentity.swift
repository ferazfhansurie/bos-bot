import Foundation
import Security

/// Why the phone cannot act as the signed-in person right now.
public enum CloudIdentityError: Error, Hashable, Sendable {
    /// The issuer refused the bearer: sign in again. Never retried.
    case sessionInvalid
    /// Timeout, 5xx or rate limit. The bearer is kept and retried; this is
    /// never proof the session is gone.
    case unavailable(retryAfter: TimeInterval?)
    case invalidEmail
    case invalidCode
    /// The issuer answered something the phone cannot use.
    case invalidResponse
}

/// The issuer's account, as GET /v1/me reports it.
public struct CloudIssuerUser: Hashable, Codable, Sendable {
    /// Better Auth's immutable user id: the subject.
    public var id: String
    public var email: String

    public init(id: String, email: String) { self.id = id; self.email = email }
}

/// Email-OTP sign-in against the control-plane issuer (D03). The signed
/// bearer comes only from the `set-auth-token` response header; the raw
/// session token in the JSON body never leaves this type.
public struct CloudIssuerClient: Sendable {
    public let baseURL: URL
    private let session: URLSession

    public init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL; self.session = session
    }

    public static func normalizedEmail(_ raw: String) -> String? {
        let email = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard email.count <= 254, email.wholeMatch(of: #/[^@\s]+@[^@\s]+\.[^@\s]+/#) != nil else { return nil }
        return email
    }

    public static func normalizedCode(_ raw: String) -> String? {
        guard raw.count <= 32 else { return nil }
        let code = raw.filter { !$0.isWhitespace && $0 != "-" }
        return code.wholeMatch(of: #/[0-9]{8}/#) != nil ? code : nil
    }

    /// Same answer for known and unknown addresses.
    public func requestCode(email raw: String) async throws {
        guard let email = Self.normalizedEmail(raw) else { throw CloudIdentityError.invalidEmail }
        _ = try await call("/api/auth/email-otp/send-verification-otp", method: "POST", body: ["email": email, "type": "sign-in"])
    }

    /// A lost response here leaves no bearer anywhere; the person asks for a
    /// new code rather than the phone retrying the spent one.
    public func verify(email raw: String, code rawCode: String) async throws -> (bearer: String, user: CloudIssuerUser) {
        guard let email = Self.normalizedEmail(raw) else { throw CloudIdentityError.invalidEmail }
        guard let code = Self.normalizedCode(rawCode) else { throw CloudIdentityError.invalidCode }
        let name = String(email.prefix { $0 != "@" })
        let (data, response) = try await call("/api/auth/sign-in/email-otp", method: "POST", body: ["email": email, "otp": code, "name": name], codeRejection: true)
        struct Body: Decodable { var user: CloudIssuerUser }
        guard let bearer = Self.boundedSecret(response.value(forHTTPHeaderField: "set-auth-token")),
              let user = try? JSONDecoder().decode(Body.self, from: data).user,
              user.email.lowercased() == email
        else { throw CloudIdentityError.invalidResponse }
        return (bearer, user)
    }

    /// Fresh validation of the stored bearer. 401 fails closed; anything
    /// that is not an answer is `unavailable`.
    public func me(bearer: String) async throws -> CloudIssuerUser {
        let (data, _) = try await call("/v1/me", method: "GET", bearer: bearer)
        struct Body: Decodable { var user: CloudIssuerUser }
        guard let user = try? JSONDecoder().decode(Body.self, from: data).user else { throw CloudIdentityError.invalidResponse }
        return user
    }

    /// Revokes the session at the issuer. Best effort: local erase happens
    /// whether or not this reaches the server.
    public func signOut(bearer: String) async throws {
        _ = try await call("/api/auth/sign-out", method: "POST", body: [String: String](), bearer: bearer)
    }

    static func boundedSecret(_ value: String?) -> String? {
        guard let value, (16...4096).contains(value.count), value.allSatisfy({ $0.isASCII && !$0.isWhitespace }) else { return nil }
        return value
    }

    private func call(_ path: String, method: String, body: [String: String]? = nil, bearer: String? = nil, codeRejection: Bool = false) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: baseURL.appendingPathComponent(String(path.dropFirst())), timeoutInterval: CloudLimits.requestSeconds)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        let data: Data, response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw CloudIdentityError.unavailable(retryAfter: nil)
        }
        guard let http = response as? HTTPURLResponse else { throw CloudIdentityError.unavailable(retryAfter: nil) }
        switch http.statusCode {
        case 200...299: return (data, http)
        case 401 where bearer != nil: throw CloudIdentityError.sessionInvalid
        case 400...403 where codeRejection: throw CloudIdentityError.invalidCode
        case 429, 500...599:
            throw CloudIdentityError.unavailable(retryAfter: http.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init))
        default: throw CloudIdentityError.invalidResponse
        }
    }
}

/// The room service's view of a bearer: GET /v2/me.
public struct CloudIdentity: Hashable, Codable, Sendable {
    public var accountId: String
    public var issuer: String
    public var subject: String
    public var service: String

    public init(accountId: String, issuer: String, subject: String, service: String) {
        self.accountId = accountId; self.issuer = issuer; self.subject = subject; self.service = service
    }

    public var key: CloudAccountKey { CloudAccountKey(service: service, issuer: issuer, subject: subject) }

    enum CodingKeys: String, CodingKey { case accountId = "account_id", issuer, subject, service }
}

/// Where bearers live. One item per (service, issuer, subject); nothing is
/// readable under another account's key.
public protocol CloudCredentialStore: Sendable {
    func bearer(for account: CloudAccountKey) throws -> String?
    func save(_ bearer: String, for account: CloudAccountKey) throws
    func remove(_ account: CloudAccountKey) throws
}

public extension CloudAccountKey {
    /// `service|issuer|subject`, each part length-prefixed so separators
    /// inside a part cannot collide.
    var credentialKey: String {
        [service, issuer, subject].map { "\($0.utf8.count):\($0)" }.joined(separator: "|")
    }
}

public enum CloudKeychainError: Error, Hashable, Sendable {
    /// errSecInteractionNotAllowed and friends: the bearer may well exist.
    case unavailable(OSStatus)
}

/// Keychain store for the app. Readable after first unlock so foreground
/// recovery works, never synced or restored onto another device.
public struct CloudKeychainStore: CloudCredentialStore {
    public static let service = "com.openmausbot.cloud.bearer"
    private let accessGroup: String?

    public init(accessGroup: String? = nil) { self.accessGroup = accessGroup }

    private func query(_ account: CloudAccountKey) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account.credentialKey,
            kSecUseDataProtectionKeychain as String: true,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        return query
    }

    public func bearer(for account: CloudAccountKey) throws -> String? {
        var query = query(account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw CloudKeychainError.unavailable(status) }
        return String(data: data, encoding: .utf8)
    }

    public func save(_ bearer: String, for account: CloudAccountKey) throws {
        let base = query(account)
        let attributes: [String: Any] = [
            kSecValueData as String: Data(bearer.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(base.merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw CloudKeychainError.unavailable(status) }
    }

    public func remove(_ account: CloudAccountKey) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CloudKeychainError.unavailable(status) }
    }
}

/// What the app should show for identity.
public enum CloudIdentityState: Hashable, Sendable {
    case signedOut
    case signedIn(CloudIdentity)
    /// The issuer cannot answer; the session is kept and retried.
    case unavailable(CloudIdentity, retryAfter: TimeInterval?)
    /// The issuer refused the bearer. It is deleted; the account's local
    /// data stays scoped on disk until that person signs in or logs out.
    case revoked(CloudAccountKey)
}

/// The one coordinator that owns the bearer for the signed-in account
/// (D03). Every /v2 request asks it for the bearer; validation goes to the
/// issuer's /v1/me with caches bypassed.
public actor CloudIdentityCoordinator {
    public let issuer: CloudIssuerClient
    public let roomsURL: URL
    private let store: CloudCredentialStore
    private let defaults: UserDefaults
    private let urlSession: URLSession
    public private(set) var state: CloudIdentityState = .signedOut
    private var bearerValue: String?

    static let currentKey = "cloud.currentIdentity"

    public init(issuer: CloudIssuerClient, roomsURL: URL, store: CloudCredentialStore, defaults: UserDefaults = .standard, urlSession: URLSession = .shared) {
        self.issuer = issuer; self.roomsURL = roomsURL; self.store = store
        self.defaults = defaults; self.urlSession = urlSession
    }

    /// The last signed-in identity and its bearer, if the keychain still
    /// holds one. Nothing is validated here.
    public func restore() throws -> CloudIdentityState {
        guard let data = defaults.data(forKey: Self.currentKey),
              let identity = try? JSONDecoder().decode(CloudIdentity.self, from: data)
        else { return state }
        guard let bearer = try store.bearer(for: identity.key) else {
            state = .revoked(identity.key)
            return state
        }
        bearerValue = bearer
        state = .signedIn(identity)
        return state
    }

    public func requestCode(email: String) async throws {
        try await issuer.requestCode(email: email)
    }

    /// Code -> signed bearer -> issuer /v1/me -> room service /v2/me, then
    /// the bearer is stored under the room service's (service, issuer, subject).
    public func signIn(email: String, code: String) async throws -> CloudIdentity {
        let (bearer, user) = try await issuer.verify(email: email, code: code)
        let identity = try await roomIdentity(bearer: bearer)
        guard identity.subject == user.id else { throw CloudIdentityError.invalidResponse }
        try store.save(bearer, for: identity.key)
        defaults.set(try JSONEncoder().encode(identity), forKey: Self.currentKey)
        bearerValue = bearer
        state = .signedIn(identity)
        return identity
    }

    /// For CloudClient. Throws rather than sending without a bearer.
    public func bearer() throws -> String {
        guard let bearerValue else { throw CloudIdentityError.sessionInvalid }
        return bearerValue
    }

    /// Foreground validation against the issuer. A 401 deletes the bearer;
    /// an outage keeps it.
    @discardableResult
    public func validate() async -> CloudIdentityState {
        guard let identity = currentIdentity, let bearer = bearerValue else { return state }
        do {
            let user = try await issuer.me(bearer: bearer)
            guard user.id == identity.subject, currentIdentity == identity else { return revoke(identity.key) }
            state = .signedIn(identity)
        } catch CloudIdentityError.sessionInvalid {
            return revoke(identity.key)
        } catch CloudIdentityError.unavailable(let retryAfter) {
            state = .unavailable(identity, retryAfter: retryAfter)
        } catch {
            state = .unavailable(identity, retryAfter: nil)
        }
        return state
    }

    /// The room service said session_invalid: the same as a 401 here.
    @discardableResult
    public func sessionRejected() -> CloudIdentityState {
        guard let identity = currentIdentity else { return state }
        return revoke(identity.key)
    }

    /// Explicit logout: revoke at the issuer if reachable, delete the bearer
    /// and forget the pointer. The caller erases the account's store.
    public func signOut() async {
        let account = currentIdentity?.key ?? revokedKey
        if let bearerValue { try? await issuer.signOut(bearer: bearerValue) }
        if let account { try? store.remove(account) }
        defaults.removeObject(forKey: Self.currentKey)
        bearerValue = nil
        state = .signedOut
    }

    public var currentIdentity: CloudIdentity? {
        switch state {
        case .signedIn(let identity), .unavailable(let identity, _): return identity
        case .signedOut, .revoked: return nil
        }
    }

    private var revokedKey: CloudAccountKey? {
        if case .revoked(let key) = state { return key }
        return nil
    }

    private func revoke(_ key: CloudAccountKey) -> CloudIdentityState {
        try? store.remove(key)
        bearerValue = nil
        state = .revoked(key)
        return state
    }

    private func roomIdentity(bearer: String) async throws -> CloudIdentity {
        var request = URLRequest(url: roomsURL.appendingPathComponent("v2/me"), timeoutInterval: CloudLimits.requestSeconds)
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        let data: Data, response: URLResponse
        do { (data, response) = try await urlSession.data(for: request) } catch { throw CloudIdentityError.unavailable(retryAfter: nil) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else {
            let code = CloudResponseClassifier.decodeError(data)
            if code?.error.isSessionInvalid == true { throw CloudIdentityError.sessionInvalid }
            throw CloudIdentityError.unavailable(retryAfter: code?.retryAfter)
        }
        guard let identity = try? JSONDecoder().decode(CloudIdentity.self, from: data) else { throw CloudIdentityError.invalidResponse }
        return identity
    }
}
