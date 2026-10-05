import XCTest
@testable import CompanionCore
final class LeadActionTests: XCTestCase {
    func testSourceMessageRetainsBlockedAndResolvedEvidence() throws {
        let raw = #"{"id":"m","role":"bot","kind":"text","at":10,"text":"blocked @bos: repair","leadAction":{"id":"a","leadBotId":"bos","kind":"blocker","status":"resolved","requiredAction":"repair","updatedAt":20,"resolution":{"decision":"fixed","evidence":"fixture passed","by":"bos","at":20}}}"#
        let message = try JSONDecoder().decode(Message.self, from: Data(raw.utf8))
        XCTAssertEqual(message.leadAction?.status, "resolved")
        XCTAssertEqual(message.leadAction?.resolution?.evidence, "fixture passed")
    }
}
