import XCTest
@testable import CompanionCore

final class TurnRecoveryTests: XCTestCase {
    func testDecodesRestartCardRecovery() throws {
        let json = #"""
        {"name":"The host restarted while this request was active.","ok":false,"terminal":true,
         "recovery":{"id":"r1","botId":"b1","threadId":"t1"}}
        """#
        let tool = try JSONDecoder().decode(ToolActivity.self, from: Data(json.utf8))
        XCTAssertEqual(tool.terminal, true)
        XCTAssertEqual(tool.recovery?.id, "r1")
        XCTAssertEqual(tool.recovery?.isOpen, true)
    }

    func testReviewedOrResumedIsClosed() {
        XCTAssertFalse(TurnRecovery(id: "r", botId: "b", threadId: "t", reviewedAt: 1).isOpen)
        XCTAssertFalse(TurnRecovery(id: "r", botId: "b", threadId: "t", resumedAt: 1).isOpen)
    }

    func testOlderToolChipsStillDecode() throws {
        let tool = try JSONDecoder().decode(ToolActivity.self, from: Data(#"{"name":"run","ok":true}"#.utf8))
        XCTAssertNil(tool.recovery)
    }
}
