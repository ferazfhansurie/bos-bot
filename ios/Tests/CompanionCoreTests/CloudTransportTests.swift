import Foundation
import XCTest
@testable import CompanionCore

final class CloudTransportTests: XCTestCase {
    private typealias F = CloudFixture

    private func body(_ json: String) -> Data { Data(json.utf8) }
    private func error(_ code: String) -> Data { body(#"{"error":"\#(code)"}"#) }

    private func object(_ frame: CloudOutboundFrame) throws -> [String: CloudJSON] {
        guard case .object(let object) = try CloudJSON(encoding: frame) else {
            XCTFail("frame is not a JSON object")
            return [:]
        }
        return object
    }

    // MARK: - Submit classifier

    func testSubmitOutagesAreIndeterminate() {
        let cases: [(Int, Data)] = [
            (401, error("unauthenticated")),
            (401, Data()),
            (500, error("unavailable")),
            (500, body("<html>oops</html>")),
            (503, error("identity_unavailable")),
            (503, Data()),
            (504, error("deadline_exceeded")),
            (0, Data()),
            (502, body(#"{"message":"bad gateway"}"#)),
            (400, error("some_future_code")),
            (403, error("forbidden")),
            (404, error("not_found")),
        ]
        for (status, data) in cases {
            XCTAssertEqual(CloudResponseClassifier.submit(status: status, body: data, retryAfterHeader: nil), .indeterminate, "\(status) \(String(decoding: data, as: UTF8.self))")
        }
    }

    func testSubmitRateLimited() {
        XCTAssertEqual(CloudResponseClassifier.submit(status: 429, body: body(#"{"error":"rate_limited","retry_after":3}"#), retryAfterHeader: nil), .rateLimited(retryAfter: 3))
        XCTAssertEqual(CloudResponseClassifier.submit(status: 429, body: body(#"{"error":"rate_limited","retry_after":3}"#), retryAfterHeader: "9"), .rateLimited(retryAfter: 3), "body wins")
        XCTAssertEqual(CloudResponseClassifier.submit(status: 429, body: Data(), retryAfterHeader: "7"), .rateLimited(retryAfter: 7))
        XCTAssertEqual(CloudResponseClassifier.submit(status: 429, body: Data(), retryAfterHeader: nil), .rateLimited(retryAfter: 1))
        XCTAssertEqual(CloudResponseClassifier.lookup(status: 429, body: body(#"{"error":"rate_limited","retry_after":2.5}"#), retryAfterHeader: nil), .rateLimited(retryAfter: 2.5))
    }

    func testSubmitDefinitiveRejections() {
        for status in [400, 422] {
            XCTAssertEqual(CloudResponseClassifier.submit(status: status, body: error("policy_changed"), retryAfterHeader: nil), .outcome(.rejected(CloudRejection(clientOperationId: "", digest: nil, reason: .policyChanged))))
        }
        for code in ["invalid_request", "invalid_mention", "unsupported_attachment", "invalid_reply", "operation_expired"] {
            guard case .outcome(.rejected(let rejection)) = CloudResponseClassifier.submit(status: 422, body: error(code), retryAfterHeader: nil) else {
                XCTFail(code); continue
            }
            XCTAssertEqual(rejection.reason.rawValue, code)
        }
    }

    func testSubmitConflictIsRecoveryUnknown() {
        XCTAssertEqual(CloudResponseClassifier.submit(status: 409, body: error("operation_conflict"), retryAfterHeader: nil), .outcome(.recoveryUnknown))
        XCTAssertEqual(CloudResponseClassifier.submit(status: 409, body: error("recovery_unknown"), retryAfterHeader: nil), .outcome(.recoveryUnknown))
    }

    func testLookupDenialsAreIndeterminate() {
        for (status, data) in [(403, error("forbidden")), (404, error("not_found")), (401, error("unauthenticated")), (500, Data()), (409, error("operation_conflict")), (422, error("policy_changed"))] {
            XCTAssertEqual(CloudResponseClassifier.lookup(status: status, body: data, retryAfterHeader: nil), .indeterminate, "\(status)")
        }
    }

    func testOkBodiesDecode() {
        let digest = String(repeating: "a", count: 64)
        let accepted = body(#"{"status":"accepted","client_operation_id":"window1.abcdefghijklmnop","digest":"\#(digest)","message_id":"m1","room_id":"r1","thread_id":"t1","sequence":"12","redacted":false,"retry":"none"}"#)
        let expectedAcceptance = CloudSubmitResult.outcome(.accepted(CloudAcceptance(clientOperationId: "window1.abcdefghijklmnop", digest: digest, messageId: "m1", roomId: "r1", threadId: "t1", sequence: CloudSequence(12), redacted: false)))
        let rejected = body(#"{"status":"rejected","client_operation_id":"window1.abcdefghijklmnop","digest":"\#(digest)","reason":"policy_changed","retry":"none"}"#)
        let expectedRejection = CloudSubmitResult.outcome(.rejected(CloudRejection(clientOperationId: "window1.abcdefghijklmnop", digest: digest, reason: .policyChanged)))
        let notFound = body(#"{"status":"not_found","client_operation_id":"window1.abcdefghijklmnop","retry":"unchanged_or_seal"}"#)
        let unknown = body(#"{"status":"recovery_unknown","client_operation_id":"window1.abcdefghijklmnop","retry":"reconcile_only"}"#)

        for classify in [CloudResponseClassifier.submit, CloudResponseClassifier.lookup] {
            XCTAssertEqual(classify(200, accepted, nil), expectedAcceptance)
            XCTAssertEqual(classify(200, rejected, nil), expectedRejection)
            XCTAssertEqual(classify(200, notFound, nil), .outcome(.notFound))
            XCTAssertEqual(classify(200, unknown, nil), .outcome(.recoveryUnknown))
            XCTAssertEqual(classify(201, accepted, nil), expectedAcceptance)
            XCTAssertEqual(classify(200, body(#"{"status":"pending"}"#), nil), .indeterminate)
            XCTAssertEqual(classify(200, body("garbage"), nil), .indeterminate)
        }
    }

    // MARK: - Outbound frames

    func testSubscribeFrameEncodesNullCursorAndOmitsSnapshotId() throws {
        let frame = CloudOutboundFrame.subscribe(workspaceId: "w1", roomId: "r1", threadId: "t1", cursor: nil, snapshotId: nil)
        XCTAssertEqual(try object(frame), [
            "type": .string("subscribe"), "workspace_id": .string("w1"), "room_id": .string("r1"), "thread_id": .string("t1"), "cursor": .null,
        ])
        let raw = String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
        XCTAssertTrue(raw.contains(#""cursor":null"#), raw)
        XCTAssertFalse(raw.contains("snapshot_id"), raw)

        let resumed = CloudOutboundFrame.subscribe(workspaceId: "w1", roomId: "r1", threadId: "t1", cursor: "c3", snapshotId: "s1")
        XCTAssertEqual(try object(resumed), [
            "type": .string("subscribe"), "workspace_id": .string("w1"), "room_id": .string("r1"), "thread_id": .string("t1"), "cursor": .string("c3"), "snapshot_id": .string("s1"),
        ])
    }

    func testAuthenticateFrameShape() throws {
        XCTAssertEqual(try object(.authenticate(bearer: "token-1")), ["type": .string("authenticate"), "bearer": .string("token-1")])
    }

    func testInboundFramesDecode() throws {
        let heartbeat = try JSONDecoder().decode(CloudFrame.self, from: body(#"{"type":"heartbeat"}"#))
        XCTAssertEqual(heartbeat, .heartbeat)
        XCTAssertEqual(try JSONDecoder().decode(CloudFrame.self, from: body(#"{"type":"error","error":"upgrade_required"}"#)), .error(.upgradeRequired))
        let reset = try JSONDecoder().decode(CloudFrame.self, from: body(#"{"type":"reset_required","workspace_id":"w1","room_id":"r1","reason":"overflow"}"#))
        XCTAssertEqual(reset, .reset(CloudReset(workspaceId: "w1", roomId: "r1", reason: .overflow, snapshot: nil)))
        XCTAssertThrowsError(try JSONDecoder().decode(CloudFrame.self, from: body(#"{"type":"mystery"}"#)))
    }

    // MARK: - Routes

    func testRoutesMatchReadme() {
        let op = CloudOperationID(rawValue: "window1.abcdefghijklmnop")
        XCTAssertEqual(CloudRoute.discovery, "/v2/discovery/sync")
        XCTAssertEqual(CloudRoute.realtime, "/v2/realtime")
        XCTAssertEqual(CloudRoute.operationWindows(workspaceId: "w1"), "/v2/workspaces/w1/operation-windows")
        XCTAssertEqual(CloudRoute.send(workspaceId: "w1"), "/v2/workspaces/w1/messages")
        XCTAssertEqual(CloudRoute.operation(workspaceId: "w1", operationId: op), "/v2/workspaces/w1/operations/window1.abcdefghijklmnop")
        XCTAssertEqual(CloudRoute.resolveNotAccepted(workspaceId: "w1", operationId: op), "/v2/workspaces/w1/operations/window1.abcdefghijklmnop/resolve-not-accepted")
        XCTAssertEqual(CloudRoute.snapshot(workspaceId: "w1", roomId: "r1"), "/v2/workspaces/w1/rooms/r1/snapshot")
        XCTAssertEqual(CloudRoute.read(workspaceId: "w1", roomId: "r1"), "/v2/workspaces/w1/rooms/r1/read")
        // Path segments never inject extra path components.
        XCTAssertEqual(CloudRoute.send(workspaceId: "w/1?x"), "/v2/workspaces/w%2F1%3Fx/messages")
    }

    // MARK: - Canonical JSON

    private func canonical(_ json: String) throws -> String {
        try JSONDecoder().decode(CloudJSON.self, from: body(json)).canonical
    }

    func testCanonicalSortsKeysRecursively() throws {
        XCTAssertEqual(try canonical(#"{"b":1,"a":{"z":[3,{"y":true,"x":null}],"c":"d"}}"#), #"{"a":{"c":"d","z":[3,{"x":null,"y":true}]},"b":1}"#)
        // UTF-16 code unit order: U+1F600 (D83D DE00) sorts before U+FF5E.
        let emoji = "\u{1F600}", wave = "\u{FF5E}"
        XCTAssertEqual(CloudJSON.object([wave: .integer(1), emoji: .integer(2), "z": .integer(3), "\u{e9}": .integer(4)]).canonical, "{\"z\":3,\"\u{e9}\":4,\"\(emoji)\":2,\"\(wave)\":1}")
    }

    func testCanonicalEscapes() {
        XCTAssertEqual(CloudJSON.string("a\"b").canonical, #""a\"b""#)
        XCTAssertEqual(CloudJSON.string("a\\b").canonical, #""a\\b""#)
        XCTAssertEqual(CloudJSON.string("line\nnext").canonical, #""line\nnext""#)
        XCTAssertEqual(CloudJSON.string("\r\t\u{08}\u{0C}").canonical, #""\r\t\b\f""#)
        XCTAssertEqual(CloudJSON.string("\u{01}").canonical, #""\u0001""#)
        XCTAssertEqual(CloudJSON.string("\u{1F}").canonical, #""\u001f""#)
        XCTAssertEqual(CloudJSON.string("\u{7F}/").canonical, "\"\u{7F}/\"", "DEL and slash stay raw, like JSON.stringify")
        XCTAssertEqual(CloudJSON.object(["k\"\n": .string("v")]).canonical, #"{"k\"\n":"v"}"#)
    }

    func testCanonicalKeepsNonAsciiRaw() {
        let text = "caf\u{e9} \u{1F44B} \u{4E2D}\u{6587}"
        XCTAssertEqual(CloudJSON.string(text).canonical, "\"\(text)\"")
        // No normalization: precomposed and decomposed stay distinct bytes
        // (Swift String == is canonical-equivalence, so compare UTF-8).
        XCTAssertEqual(Array(CloudJSON.string("\u{e9}").canonical.utf8), [0x22, 0xC3, 0xA9, 0x22])
        XCTAssertEqual(Array(CloudJSON.string("e\u{301}").canonical.utf8), [0x22, 0x65, 0xCC, 0x81, 0x22])
        XCTAssertNotEqual(CloudDigest.sha256(CloudJSON.string("\u{e9}").canonical), CloudDigest.sha256(CloudJSON.string("e\u{301}").canonical))
    }

    func testCanonicalKeepsIntegersIntegers() throws {
        XCTAssertEqual(try JSONDecoder().decode(CloudJSON.self, from: body("42")), .integer(42))
        XCTAssertEqual(try canonical(#"{"n":42,"neg":-7,"zero":0,"f":1.5,"t":true,"one":1}"#), #"{"f":1.5,"n":42,"neg":-7,"one":1,"t":true,"zero":0}"#)
        XCTAssertEqual(try JSONDecoder().decode(CloudJSON.self, from: body("[1,true,0,false]")), .array([.integer(1), .bool(true), .integer(0), .bool(false)]))
        XCTAssertEqual(CloudJSON.integer(9_007_199_254_740_993).canonical, "9007199254740993")
        XCTAssertEqual(CloudJSON.array([.integer(1), .string("1"), .null]).canonical, #"[1,"1",null]"#)
    }

    func testEnvelopeCanonicalCoversNullReplyKey() throws {
        let envelope = F.envelope(1)
        let canonical = try CloudJSON(encoding: envelope).canonical
        XCTAssertTrue(canonical.contains(#""reply_to_message_id":null"#), canonical)
        XCTAssertTrue(canonical.hasPrefix(#"{"attachment_ids":[],"client_operation_id":"window1.nonce00000000001","#), canonical)
        XCTAssertEqual(envelope.digest, CloudDigest.sha256(canonical))
        XCTAssertNotEqual(envelope.digest, F.envelope(1, replyTo: "m1").digest)
    }
}
