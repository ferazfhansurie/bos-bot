import Foundation
import XCTest
@testable import CompanionCore

/// Answers requests from a per-test table; fictional data only.
final class CloudStubProtocol: URLProtocol {
    struct Reply { var status: Int; var body: String; var headers: [String: String] = [:] }
    nonisolated(unsafe) static var handler: ((URLRequest) -> Reply?)?
    nonisolated(unsafe) static var seen: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var request = request
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            request.httpBody = data
        }
        Self.seen.append(request)
        guard let reply = Self.handler?(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.timedOut))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CloudStubProtocol.self]
        return URLSession(configuration: config)
    }
}

final class MemoryCredentialStore: CloudCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: String] = [:]
    var failReads: OSStatus?

    func bearer(for account: CloudAccountKey) throws -> String? {
        lock.lock(); defer { lock.unlock() }
        if let failReads { throw CloudKeychainError.unavailable(failReads) }
        return items[account.credentialKey]
    }
    func save(_ bearer: String, for account: CloudAccountKey) throws {
        lock.lock(); defer { lock.unlock() }
        items[account.credentialKey] = bearer
    }
    func remove(_ account: CloudAccountKey) throws {
        lock.lock(); defer { lock.unlock() }
        items[account.credentialKey] = nil
    }
    var count: Int { lock.lock(); defer { lock.unlock() }; return items.count }
}

final class CloudIdentityTests: XCTestCase {
    private let issuerURL = URL(string: "http://issuer.example.test")!
    private let roomsURL = URL(string: "http://rooms.example.test")!
    private let signed = "fictional-signed-bearer-0001.sig"
    private let subject = "00000000-0000-4000-8000-00000000a11c"
    private var defaults: UserDefaults!

    override func setUp() {
        CloudStubProtocol.seen = []
        CloudStubProtocol.handler = nil
        defaults = UserDefaults(suiteName: "cloud-identity-tests-\(UUID().uuidString)")
    }

    private var identityJSON: String {
        #"{"account_id":"acct_alice","issuer":"http://issuer.example.test","subject":"\#(subject)","service":"bos-cloud-local"}"#
    }
    private var userJSON: String { #"{"user":{"id":"\#(subject)","email":"alice@example.test","name":"alice","emailVerified":true}}"# }

    private func happyIssuer(_ request: URLRequest) -> CloudStubProtocol.Reply? {
        switch (request.url!.host, request.url!.path) {
        case ("issuer.example.test", "/api/auth/email-otp/send-verification-otp"):
            return .init(status: 200, body: #"{"success":true}"#)
        case ("issuer.example.test", "/api/auth/sign-in/email-otp"):
            return .init(status: 200, body: #"{"token":"raw-db-token-never-used","user":{"id":"\#(subject)","email":"alice@example.test"}}"#, headers: ["set-auth-token": signed])
        case ("issuer.example.test", "/v1/me"):
            return .init(status: 200, body: userJSON)
        case ("issuer.example.test", "/api/auth/sign-out"):
            return .init(status: 200, body: #"{"success":true}"#)
        case ("rooms.example.test", "/v2/me"):
            return .init(status: 200, body: identityJSON)
        default:
            return .init(status: 404, body: #"{"error":"not_found"}"#)
        }
    }

    private func coordinator(_ store: CloudCredentialStore) -> CloudIdentityCoordinator {
        let session = CloudStubProtocol.session()
        return CloudIdentityCoordinator(issuer: CloudIssuerClient(baseURL: issuerURL, session: session), roomsURL: roomsURL, store: store, defaults: defaults, urlSession: session)
    }

    private func body(_ request: URLRequest) -> [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: request.httpBody ?? Data())) ?? [:]
    }

    // MARK: - issuer client

    func testNormalization() {
        XCTAssertEqual(CloudIssuerClient.normalizedEmail("  Alice@Example.TEST "), "alice@example.test")
        XCTAssertNil(CloudIssuerClient.normalizedEmail("alice"))
        XCTAssertNil(CloudIssuerClient.normalizedEmail("a b@example.test"))
        XCTAssertEqual(CloudIssuerClient.normalizedCode("1234-5678"), "12345678")
        XCTAssertEqual(CloudIssuerClient.normalizedCode(" 1234 5678 "), "12345678")
        XCTAssertNil(CloudIssuerClient.normalizedCode("1234567"))
        XCTAssertNil(CloudIssuerClient.normalizedCode("abcdefgh"))
    }

    func testSignInUsesOnlyTheSignedHeaderBearer() async throws {
        CloudStubProtocol.handler = happyIssuer
        let store = MemoryCredentialStore()
        let identity = coordinator(store)
        try await identity.requestCode(email: "Alice@example.test")
        let signedIn = try await identity.signIn(email: "alice@example.test", code: "1234 5678")
        XCTAssertEqual(signedIn.subject, subject)
        XCTAssertEqual(signedIn.accountId, "acct_alice")

        let sent = CloudStubProtocol.seen
        XCTAssertEqual(body(sent[0]), ["email": "alice@example.test", "type": "sign-in"])
        XCTAssertEqual(body(sent[1])["otp"], "12345678")
        XCTAssertNil(sent[1].value(forHTTPHeaderField: "Authorization"))
        XCTAssertEqual(sent[2].url?.path, "/v2/me")
        XCTAssertEqual(sent[2].value(forHTTPHeaderField: "Authorization"), "Bearer \(signed)")

        let bearer = try await identity.bearer()
        XCTAssertEqual(bearer, signed, "the raw body token is never the bearer")
        XCTAssertEqual(try store.bearer(for: signedIn.key), signed)
        XCTAssertFalse(sent.contains { $0.value(forHTTPHeaderField: "Authorization")?.contains("raw-db-token") == true })
    }

    func testSignInWithoutHeaderFails() async {
        CloudStubProtocol.handler = { request in
            if request.url!.path == "/api/auth/sign-in/email-otp" {
                return .init(status: 200, body: #"{"token":"raw-db-token-never-used","user":{"id":"x","email":"alice@example.test"}}"#)
            }
            return self.happyIssuer(request)
        }
        let store = MemoryCredentialStore()
        do {
            _ = try await coordinator(store).signIn(email: "alice@example.test", code: "12345678")
            XCTFail("signed in without a signed bearer")
        } catch {
            XCTAssertEqual(error as? CloudIdentityError, .invalidResponse)
        }
        XCTAssertEqual(store.count, 0)
    }

    func testWrongCodeIsInvalidCode() async {
        CloudStubProtocol.handler = { request in
            if request.url!.path == "/api/auth/sign-in/email-otp" { return .init(status: 400, body: #"{"code":"INVALID_OTP"}"#) }
            return self.happyIssuer(request)
        }
        do {
            _ = try await coordinator(MemoryCredentialStore()).signIn(email: "alice@example.test", code: "00000000")
            XCTFail("wrong code signed in")
        } catch {
            XCTAssertEqual(error as? CloudIdentityError, .invalidCode)
        }
    }

    func testRoomSubjectMustMatchIssuerUser() async {
        CloudStubProtocol.handler = { request in
            if request.url!.path == "/v2/me" {
                return .init(status: 200, body: #"{"account_id":"acct_mallory","issuer":"http://issuer.example.test","subject":"someone-else","service":"bos-cloud-local"}"#)
            }
            return self.happyIssuer(request)
        }
        let store = MemoryCredentialStore()
        do {
            _ = try await coordinator(store).signIn(email: "alice@example.test", code: "12345678")
            XCTFail("mismatched subject accepted")
        } catch {
            XCTAssertEqual(error as? CloudIdentityError, .invalidResponse)
        }
        XCTAssertEqual(store.count, 0)
    }

    // MARK: - validation

    func testValidateOutageKeepsBearerAndUnauthorizedRevokes() async throws {
        CloudStubProtocol.handler = happyIssuer
        let store = MemoryCredentialStore()
        let identity = coordinator(store)
        let signedIn = try await identity.signIn(email: "alice@example.test", code: "12345678")
        let ok = await identity.validate()
        XCTAssertEqual(ok, .signedIn(signedIn))

        // Timeout: unavailable, bearer kept.
        CloudStubProtocol.handler = { _ in nil }
        let timedOut = await identity.validate()
        XCTAssertEqual(timedOut, .unavailable(signedIn, retryAfter: nil))
        XCTAssertEqual(try store.bearer(for: signedIn.key), signed)
        // 5xx with Retry-After: unavailable, never invalid.
        CloudStubProtocol.handler = { _ in .init(status: 503, body: "", headers: ["Retry-After": "4"]) }
        let outage = await identity.validate()
        XCTAssertEqual(outage, .unavailable(signedIn, retryAfter: 4))
        XCTAssertEqual(try store.bearer(for: signedIn.key), signed)
        // Recovery after the outage.
        CloudStubProtocol.handler = happyIssuer
        let back = await identity.validate()
        XCTAssertEqual(back, .signedIn(signedIn))

        // 401: fail closed, bearer deleted.
        CloudStubProtocol.handler = { _ in .init(status: 401, body: #"{"error":"unauthorized"}"#) }
        let revoked = await identity.validate()
        XCTAssertEqual(revoked, .revoked(signedIn.key))
        XCTAssertNil(try store.bearer(for: signedIn.key))
        do { _ = try await identity.bearer(); XCTFail("bearer after revoke") } catch {}
    }

    func testValidateDifferentUserRevokes() async throws {
        CloudStubProtocol.handler = happyIssuer
        let store = MemoryCredentialStore()
        let identity = coordinator(store)
        let signedIn = try await identity.signIn(email: "alice@example.test", code: "12345678")
        CloudStubProtocol.handler = { _ in .init(status: 200, body: #"{"user":{"id":"other","email":"bob@example.test"}}"#) }
        let state = await identity.validate()
        XCTAssertEqual(state, .revoked(signedIn.key))
        XCTAssertEqual(store.count, 0)
    }

    func testRoomServiceSessionInvalidRevokes() async throws {
        CloudStubProtocol.handler = happyIssuer
        let store = MemoryCredentialStore()
        let identity = coordinator(store)
        let signedIn = try await identity.signIn(email: "alice@example.test", code: "12345678")
        let state = await identity.sessionRejected()
        XCTAssertEqual(state, .revoked(signedIn.key))
        XCTAssertEqual(store.count, 0)
    }

    // MARK: - restore and sign-out

    func testRestoreReadsTheScopedBearer() async throws {
        CloudStubProtocol.handler = happyIssuer
        let store = MemoryCredentialStore()
        let signedIn = try await coordinator(store).signIn(email: "alice@example.test", code: "12345678")

        let relaunched = coordinator(store)
        let restored = try await relaunched.restore()
        XCTAssertEqual(restored, .signedIn(signedIn))
        let bearer = try await relaunched.bearer()
        XCTAssertEqual(bearer, signed)

        // Locked keychain throws instead of looking signed out.
        store.failReads = errSecInteractionNotAllowed
        do { _ = try await coordinator(store).restore(); XCTFail("locked keychain looked empty") } catch {
            XCTAssertEqual(error as? CloudKeychainError, .unavailable(errSecInteractionNotAllowed))
        }
        store.failReads = nil

        // Bearer gone but pointer present: revoked, not signed in.
        try store.remove(signedIn.key)
        let gone = try await coordinator(store).restore()
        XCTAssertEqual(gone, .revoked(signedIn.key))
    }

    func testSignOutRevokesAtIssuerAndForgets() async throws {
        CloudStubProtocol.handler = happyIssuer
        let store = MemoryCredentialStore()
        let identity = coordinator(store)
        _ = try await identity.signIn(email: "alice@example.test", code: "12345678")
        await identity.signOut()
        let signOut = CloudStubProtocol.seen.last { $0.url?.path == "/api/auth/sign-out" }
        XCTAssertEqual(signOut?.value(forHTTPHeaderField: "Authorization"), "Bearer \(signed)")
        XCTAssertEqual(store.count, 0)
        let state = await identity.state
        XCTAssertEqual(state, .signedOut)
        let restored = try await coordinator(store).restore()
        XCTAssertEqual(restored, .signedOut)

        // Unreachable issuer still erases locally.
        CloudStubProtocol.handler = happyIssuer
        _ = try await identity.signIn(email: "alice@example.test", code: "12345678")
        CloudStubProtocol.handler = { _ in nil }
        await identity.signOut()
        XCTAssertEqual(store.count, 0)
    }

    func testCredentialKeysDoNotCollide() {
        let a = CloudAccountKey(service: "s", issuer: "a|b", subject: "c")
        let b = CloudAccountKey(service: "s", issuer: "a", subject: "b|c")
        XCTAssertNotEqual(a.credentialKey, b.credentialKey)
    }

    func testIdentityCodes() {
        XCTAssertTrue(CloudErrorCode.sessionInvalid.isSessionInvalid)
        XCTAssertTrue(CloudErrorCode.unauthenticated.isSessionInvalid)
        XCTAssertFalse(CloudErrorCode.identityUnavailable.isSessionInvalid)
        XCTAssertTrue(CloudErrorCode.sessionInvalid.isIndeterminate, "a refused bearer says nothing about a send")
        XCTAssertEqual(CloudResponseClassifier.submit(status: 401, body: Data(#"{"error":"session_invalid"}"#.utf8), retryAfterHeader: nil), .indeterminate)
        XCTAssertEqual(CloudResponseClassifier.submit(status: 503, body: Data(#"{"error":"identity_unavailable","retry_after":2}"#.utf8), retryAfterHeader: nil), .indeterminate)
    }
}
