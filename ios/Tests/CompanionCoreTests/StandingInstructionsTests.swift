import Foundation
import XCTest
@testable import CompanionCore

final class StandingInstructionsTests: XCTestCase {
    func testUnrelatedProfileEditDoesNotReplaceInstructions() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotProfilePatch(name: "bos"))) as! [String: Any]
        XCTAssertNil(body["soul"])
    }

    func testInstructionsPreserveWhitespaceAndExplicitClear() throws {
        for instructions in ["", "  keep these rules\n\n日本語\n"] {
            let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotProfilePatch(soul: instructions))) as! [String: Any]
            XCTAssertEqual(body["soul"] as? String, instructions)
            XCTAssertEqual(body.count, 1)
        }
    }

    func testSoulEditPinsExactPriorInstructions() throws {
        let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(BotProfilePatch(soul: "new", expectedSoul: "old\n"))) as! [String: Any]
        XCTAssertEqual(body["expectedSoul"] as? String, "old\n")
        XCTAssertEqual(body["soul"] as? String, "new")
    }

    func testOlderBotWithoutInstructionsRemainsDecodable() throws {
        let data = Data(#"{"id":"b","threadId":"t","name":"bos","title":"","description":"","notifications":true,"color":"blue","unread":false,"modelSelection":{"instanceId":"codex","model":"m"},"createdAt":0}"#.utf8)
        XCTAssertNil(try JSONDecoder().decode(Bot.self, from: data).soul)
        var value = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        value["soul"] = "Be concise."
        XCTAssertEqual(try JSONDecoder().decode(Bot.self, from: JSONSerialization.data(withJSONObject: value)).soul, "Be concise.")
    }
}
