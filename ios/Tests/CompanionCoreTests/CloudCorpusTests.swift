import Foundation
import XCTest
@testable import CompanionCore

/// Runs every case in shared/cloud-protocol/fixtures.json, the corpus api,
/// ui and the phone are all held to. Read from the repo, never copied, so
/// a corpus change shows up here first.
final class CloudCorpusTests: XCTestCase {
    private static let corpusURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("shared/cloud-protocol/fixtures.json")

    private var corpus: CloudJSON!
    private let now = Date(timeIntervalSince1970: 1_791_331_200)

    override func setUpWithError() throws {
        corpus = try JSONDecoder().decode(CloudJSON.self, from: Data(contentsOf: Self.corpusURL))
        XCTAssertEqual(corpus["schema_version"], .integer(CloudLimits.schemaVersion))
    }

    func testDigestVectors() throws {
        let vectors = try XCTUnwrap(corpus["digest_vectors"]?.arrayValue)
        XCTAssertEqual(vectors.count, 2)
        for vector in vectors {
            let raw = try XCTUnwrap(vector["envelope"])
            let expected = try XCTUnwrap(vector["sha256"]?.stringValue)
            // Both the raw JSON and the typed envelope's own encoding hash
            // to the pinned digest, null reply key included.
            XCTAssertEqual(sha256(raw.canonical), expected)
            let envelope = try raw.decode(CloudSendEnvelope.self)
            XCTAssertEqual(envelope.digest, expected)
            XCTAssertEqual(try CloudJSON(encoding: envelope), raw)
        }
    }

    func testSchemaCases() throws {
        let cases = try XCTUnwrap(corpus["schema_cases"]?.arrayValue)
        XCTAssertEqual(cases.count, 6)
        for item in cases {
            let id = item["id"]?.stringValue ?? "?"
            let value = try XCTUnwrap(item["value"])
            let valid: Bool
            switch item["schema"]?.stringValue {
            case "send":
                valid = (try? CloudSendValidation.validate(value.decode(CloudSendEnvelope.self))) != nil
            case "lookup":
                valid = (try? value.decode(CloudOperationOutcome.self)) != nil
            case "snapshot":
                valid = (try? value.decode(CloudSnapshot.self)) != nil
            case "event":
                let event = try? value.decode(CloudEvent.self)
                let message = try? event?.payload["message"]?.decode(CloudMessage.self)
                valid = message != nil
                if id == "decimal-sequence" {
                    // Never rounded through a double.
                    XCTAssertEqual(event?.sequence.rawValue, "9007199254740993", id)
                    XCTAssertEqual(message?.sequence, CloudSequence("9007199254740993"), id)
                    XCTAssertGreaterThan(try XCTUnwrap(CloudSequence("9007199254740993")), try XCTUnwrap(CloudSequence("9007199254740992")))
                }
            default:
                XCTFail("unknown schema in \(id)")
                continue
            }
            XCTAssertEqual(valid, item["valid"] == .bool(true), id)
        }
    }

    func testReducerCases() throws {
        let cases = try XCTUnwrap(corpus["reducer_cases"]?.arrayValue)
        XCTAssertEqual(cases.count, 19)
        let operation = try XCTUnwrap(corpus["digest_vectors"]?.arrayValue?.first?["envelope"]?["client_operation_id"]?.stringValue)
        for item in cases {
            try run(item, fixtureOperation: CloudOperationID(rawValue: operation))
        }
    }

    // MARK: - Harness

    private func account(_ namespace: String) -> CloudAccountKey {
        CloudAccountKey(service: "cloud-local", issuer: "stub", subject: namespace)
    }

    private func room(_ initial: CloudJSON, namespace: String) throws -> CloudRoomState {
        CloudRoomState(workspaceId: "w1", roomId: try XCTUnwrap(initial["selected_room_id"]?.stringValue), threadId: try XCTUnwrap(initial["selected_thread_id"]?.stringValue), me: namespace)
    }

    private func run(_ item: CloudJSON, fixtureOperation: CloudOperationID) throws {
        let id = try XCTUnwrap(item["id"]?.stringValue)
        let initial = try XCTUnwrap(item["initial"])
        let namespace = try XCTUnwrap(initial["namespace"]?.stringValue)
        var projection = CloudProjection(account: account(namespace), room: try room(initial, namespace: namespace))

        // The corpus starts every case from an empty projection; so does a
        // fresh room.
        XCTAssertEqual(initial["messages"], .array([]), id)
        XCTAssertEqual(initial["cursor"], .null, id)
        XCTAssertEqual(initial["outbox"], .object([:]), id)
        XCTAssertEqual(try CloudJSON(encoding: projection.room.read), initial["read"], id)

        for step in try XCTUnwrap(item["steps"]?.arrayValue) {
            switch step["type"]?.stringValue {
            case "outbox":
                let envelope = try XCTUnwrap(step["envelope"]).decode(CloudSendEnvelope.self)
                let label = try XCTUnwrap(step["state"]?.stringValue.flatMap(CloudOutboxLabel.init(rawValue:)), id)
                projection.outbox.persist(envelope, as: label, now: now)
            case "operation":
                let result = try XCTUnwrap(step["result"])
                let operation = CloudOperationID(rawValue: try XCTUnwrap(result["client_operation_id"]?.stringValue))
                let outcome = try result.decode(CloudOperationOutcome.self)
                _ = projection.operation(operation, result: .outcome(outcome), account: step["namespace"]?.stringValue.map(account), now: now)
            case "frame":
                _ = projection.receive(try XCTUnwrap(step["frame"]).decode(CloudFrame.self), now: now)
            case "snapshot":
                projection.room.apply(try XCTUnwrap(step["snapshot"]).decode(CloudSnapshot.self))
            case "read":
                _ = projection.room.apply(try XCTUnwrap(step["coverage"]).decode(CloudReadCoverage.self))
            case "account_switch":
                let next = try XCTUnwrap(step["namespace"]?.stringValue)
                projection.switchAccount(to: account(next), room: try room(initial, namespace: next))
            case let other:
                XCTFail("\(id): unknown step \(other ?? "nil")")
            }
        }

        let expected = try XCTUnwrap(item["expected"]?.objectValue)
        let entry = projection.outbox.entry(fixtureOperation)
        for (key, value) in expected {
            let message = "\(id): \(key)"
            switch key {
            case "outbox_state": XCTAssertEqual(entry?.status.label.rawValue, value.stringValue, message)
            case "outbox_envelope": XCTAssertEqual(try entry.map { try CloudJSON(encoding: $0.envelope) }, value, message)
            case "recovery_required": XCTAssertEqual(entry?.status.recoveryRequired ?? false, value == .bool(true), message)
            case "outbox_empty": XCTAssertEqual(projection.outbox.entries.isEmpty, value == .bool(true), message)
            case "message_ids": XCTAssertEqual(projection.room.messageIds.map(CloudJSON.string), value.arrayValue, message)
            case "cursor": XCTAssertEqual(projection.room.cursor.map(CloudJSON.string) ?? .null, value, message)
            case "live": XCTAssertEqual(.bool(projection.room.live), value, message)
            case "upgrade_required": XCTAssertEqual(.bool(projection.room.upgradeRequired), value, message)
            case "reset_required": XCTAssertEqual(.bool(projection.room.resetRequired), value, message)
            case "selected_room_id": XCTAssertEqual(.string(projection.room.roomId), value, message)
            case "selected_thread_id": XCTAssertEqual(.string(projection.room.threadId), value, message)
            case "read": XCTAssertEqual(try CloudJSON(encoding: projection.room.read), value, message)
            case "namespace": XCTAssertEqual(.string(projection.namespace), value, message)
            default: XCTFail("\(message) is not asserted by this harness")
            }
        }
    }

    private func sha256(_ text: String) -> String {
        CloudDigest.sha256(text)
    }
}

private extension CloudJSON {
    var arrayValue: [CloudJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }
    var objectValue: [String: CloudJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }
}
